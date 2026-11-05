// GPS SIMULATOR — development/testing only (D7). Refuses to load when NODE_ENV=production.
//
// For each ACTIVE vehicle with a gps_device_id and an assignment today, the vehicle loops along the
// route geometry if present, otherwise through the snapshot PIDs in sequence order, offset 5–15 m
// from each PID. Every flow.txt §22 edge case can be switched on via GPS_SIM_* env vars.
// Output mimics a "real" provider: naive local timestamps (GPS_PROVIDER_TIMEZONE), IMEI field, etc.
import { formatInTimeZone } from 'date-fns-tz';
import { env } from '../../../config/env.js';
import { todayInTz } from '../../../utils/time.js';
import { parseProviderTimestamp } from '../timestamps.js';
import { buildLoop, offsetM, positionAlong } from '../geoMath.js';

export const SIMULATOR_NAME = 'simulator';

export function simConfigFromEnv(e = env) {
  return {
    seed: e.GPS_SIM_SEED,
    speedKmh: e.GPS_SIM_SPEED_KMH,
    jitterM: e.GPS_SIM_JITTER_M,
    dropoutPct: e.GPS_SIM_DROPOUT_PCT,
    duplicatePct: e.GPS_SIM_DUPLICATE_PCT,
    outOfOrderPct: e.GPS_SIM_OUT_OF_ORDER_PCT,
    latePct: e.GPS_SIM_LATE_PCT,
    badPct: e.GPS_SIM_BAD_PCT,
    offlineVehicles: e.GPS_SIM_OFFLINE_VEHICLES.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    planRefreshPolls: e.GPS_SIM_PLAN_REFRESH_POLLS,
    tz: e.GPS_PROVIDER_TIMEZONE,
    opTz: e.APP_TIMEZONE,
  };
}

// ---- deterministic PRNG (mulberry32) seeded from a string hash (FNV-1a)
function hash(...parts) {
  let h = 2166136261;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function rngFor(...parts) {
  let a = hash(...parts);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One query: today's routable vehicles with their path source (geometry or snapshot PIDs). */
export async function loadPlan(db, { opTz, now = new Date() }) {
  const { rows } = await db.query(
    `SELECT v.id AS vehicle_id, v.vehicle_number, v.gps_device_id AS device_id, r.route_geometry,
            (SELECT json_agg(json_build_array(rap.pid_id, rap.pid_latitude, rap.pid_longitude)
                             ORDER BY rp.sequence_no NULLS LAST, rap.pid_id)
               FROM route_assignment_pids rap
               LEFT JOIN route_pids rp ON rp.route_id = ra.route_id AND rp.pid_id = rap.pid_id
              WHERE rap.route_assignment_id = ra.id AND rap.pid_latitude IS NOT NULL) AS pids
       FROM vehicles v
       JOIN LATERAL (
         SELECT x.id, x.route_id FROM route_assignments x
          WHERE x.vehicle_id = v.id AND x.operational_date = $1::date AND x.status <> 'CANCELLED'
          ORDER BY (x.shift_start IS NOT NULL AND $2::timestamptz >= x.shift_start AND $2::timestamptz < x.shift_end) DESC,
                   x.shift_start NULLS LAST
          LIMIT 1) ra ON true
       JOIN routes r ON r.id = ra.route_id
      WHERE v.status = 'ACTIVE' AND v.gps_device_id IS NOT NULL`,
    [todayInTz(opTz, now), now],
  );
  return rows;
}

/** Turns plan rows into loops (pure; exported for tests). */
export function buildVehicles(planRows, seed) {
  const out = [];
  for (const r of planRows) {
    let path = null;
    const coords = r.route_geometry?.type === 'LineString' ? r.route_geometry.coordinates : null;
    if (coords && coords.length >= 2) path = coords.map(([lng, lat]) => [lat, lng]);
    else if (r.pids?.length) {
      path = r.pids.map(([pidId, lat, lng]) => {
        const rnd = rngFor(seed, 'pid', pidId);
        const dist = 5 + rnd() * 10; // 5–15 m from the PID
        const ang = rnd() * 2 * Math.PI;
        return offsetM([Number(lat), Number(lng)], dist * Math.cos(ang), dist * Math.sin(ang));
      });
    }
    if (!path?.length) continue;
    out.push({ vehicle_id: r.vehicle_id, vehicle_number: r.vehicle_number, device_id: r.device_id, loop: buildLoop(path) });
  }
  return out;
}

export function createSimulatorProvider({ db, config = simConfigFromEnv(), nodeEnv = env.NODE_ENV, now = () => new Date() } = {}) {
  if (nodeEnv === 'production') {
    throw new Error('GPS provider "simulator" is for development/testing only and refuses to load when NODE_ENV=production');
  }
  const c = config;
  const speedMps = (c.speedKmh * 1000) / 3600;
  const offline = new Set(c.offlineVehicles);
  let vehicles = null;
  let pollsSincePlan = Infinity;
  let tick = 0;
  const stats = { planQueries: 0 };

  const fmt = (d) => formatInTimeZone(d, c.tz, 'yyyy-MM-dd HH:mm:ss');

  function pointAt(v, at, rnd) {
    const phase = rngFor(c.seed, 'phase', v.device_id)() * v.loop.length; // vehicles start at different spots
    const { pos, heading } = positionAlong(v.loop, phase + (speedMps * at.getTime()) / 1000);
    const j = rnd() * c.jitterM;
    const a = rnd() * 2 * Math.PI;
    const [lat, lng] = offsetM(pos, j * Math.cos(a), j * Math.sin(a));
    return {
      imei: v.device_id,
      reg_no: v.vehicle_number,
      lat: Number(lat.toFixed(7)),
      lon: Number(lng.toFixed(7)),
      speed_kmh: Number((c.speedKmh * (0.7 + rnd() * 0.6)).toFixed(1)),
      ign: 1,
      heading: Number(heading.toFixed(1)),
      hdop: Number((0.8 + rnd() * 1.5).toFixed(1)),
      ts: fmt(at),
      status: 'online',
    };
  }

  /** Pure generation for one poll tick (exported via the provider for tests). */
  function generate(nowDate, tickIndex, vs = vehicles || []) {
    const records = [];
    const pct = (p, rnd) => rnd() * 100 < p;
    for (const v of vs) {
      if (offline.has(String(v.vehicle_number).toUpperCase())) continue; // never reports
      const rnd = rngFor(c.seed, v.device_id, tickIndex);
      if (pct(c.dropoutPct, rnd)) continue;
      const at = new Date(nowDate.getTime() - Math.floor(rnd() * 20_000)); // 0–20 s device-to-provider lag
      let rec = pointAt(v, at, rnd);
      if (pct(c.badPct, rnd)) rec = { ...rec, ...(rnd() < 0.5 ? { lat: 0, lon: 0 } : { lat: 123.456, lon: 77.3 }) };
      records.push(rec);
      if (pct(c.duplicatePct, rnd)) records.push({ ...rec });
      if (pct(c.outOfOrderPct, rnd)) records.push(pointAt(v, new Date(at.getTime() - (60 + rnd() * 60) * 1000), rnd));
      if (pct(c.latePct, rnd)) records.push(pointAt(v, new Date(at.getTime() - (5 + rnd() * 25) * 60_000), rnd));
    }
    return records;
  }

  return {
    name: SIMULATOR_NAME,
    stats,
    generate,
    setVehicles(vs) { vehicles = vs; pollsSincePlan = 0; },

    async fetchLatest({ signal } = {}) {
      signal?.throwIfAborted?.();
      if (!vehicles || pollsSincePlan >= c.planRefreshPolls) {
        stats.planQueries++;
        vehicles = buildVehicles(await loadPlan(db, { opTz: c.opTz, now: now() }), c.seed);
        pollsSincePlan = 0;
      }
      pollsSincePlan++;
      return generate(now(), tick++);
    },

    async fetchHistory({ deviceId, from, to, signal } = {}) {
      signal?.throwIfAborted?.();
      const v = (vehicles || []).find((x) => x.device_id === deviceId);
      if (!v) return [];
      const out = [];
      for (let t = new Date(from).getTime(); t <= new Date(to).getTime(); t += 30_000) {
        out.push(pointAt(v, new Date(t), rngFor(c.seed, 'hist', deviceId, t)));
      }
      return out;
    },

    normalize(raw) {
      const ts = parseProviderTimestamp(raw.ts, c.tz);
      if (ts.error) return { error: ts.error };
      const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));
      return {
        ok: {
          device_id: String(raw.imei),
          vehicle_number: raw.reg_no,
          latitude: num(raw.lat),
          longitude: num(raw.lon),
          speed: num(raw.speed_kmh),
          ignition: raw.ign === null || raw.ign === undefined ? null : raw.ign === 1 || raw.ign === true,
          heading: num(raw.heading),
          gps_accuracy: num(raw.hdop),
          recorded_at: ts.ok,
          provider_status: raw.status ?? null,
          raw,
        },
      };
    },
  };
}
