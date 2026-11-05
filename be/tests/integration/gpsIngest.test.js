import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../../src/config/database.js';
import { pollOnce, ingestBatch, createDeviceCache, INSERT_CHUNK } from '../../src/services/gps/gpsTrackerService.js';
import { gpsEvents } from '../../src/services/gps/gpsEvents.js';
import { createAdvisoryLock, lockKeyFor } from '../../src/jobs/gpsPollingJob.js';
import { createSimulatorProvider, simConfigFromEnv } from '../../src/services/gps/providers/simulatorProvider.js';
import { haversineM } from '../../src/services/gps/geoMath.js';
import { todayInTz } from '../../src/utils/time.js';
import { createVehicle, createRouteWithPids, uid } from '../helpers/fixtures.js';

/** Counts every round trip made through the executor (the ≤ 5 per poll budget). */
const counting = () => {
  const db = { n: 0, sql: [], query(text, params) { db.n++; db.sql.push(text.trim().split(/\s+/).slice(0, 3).join(' ')); return pool.query(text, params); } };
  return db;
};

/** Stub provider: emits whatever records the test sets; normalize maps 1:1. */
const stubProvider = () => {
  const p = {
    name: 'stub', records: [],
    async fetchLatest() { return p.records; },
    normalize: (r) => (r.badTs ? { error: 'BAD_TIMESTAMP' } : {
      ok: { device_id: r.device, latitude: r.lat, longitude: r.lng, speed: r.speed ?? 10, ignition: true, heading: null, gps_accuracy: null,
        recorded_at: new Date(r.at), provider_status: 'online', raw: r },
    }),
  };
  return p;
};

let devices = [];
let vehicleIds = [];

beforeAll(async () => {
  const s = uid();
  const { rows } = await pool.query(
    `INSERT INTO vehicles (vehicle_number, vehicle_type, gps_device_id)
     SELECT 'GI' || $1 || lpad(g::text, 3, '0'), 'Tipper', 'GIDEV' || $1 || '-' || g FROM generate_series(1, 200) g
     RETURNING id, gps_device_id`, [s]);
  devices = rows.map((r) => r.gps_device_id);
  vehicleIds = rows.map((r) => r.id);
});

const recordsAt = (at, n = 200) => devices.slice(0, n).map((d, i) => ({ device: d, lat: 28.4 + i * 1e-4, lng: 77.3, at }));

describe('pollOnce / ingestBatch', () => {
  it('ingests a 200-vehicle poll in ≤ 5 DB round trips (4 on a cold cache, 3 warm) and emits ingested', async () => {
    const provider = stubProvider();
    const cache = createDeviceCache();
    const events = [];
    const onEvt = (e) => events.push(e);
    gpsEvents.on('ingested', onEvt);
    try {
      provider.records = recordsAt(Date.now() - 60_000);
      const db1 = counting();
      const s1 = await pollOnce({ db: db1, provider, deviceCache: cache });
      expect(s1).toMatchObject({ outcome: 'SUCCESS', received: 200, saved: 200, rejected: 0, duplicates: 0, latestUpdated: 200 });
      expect(db1.n).toBeLessThanOrEqual(5);
      expect(db1.n).toBe(4);

      provider.records = recordsAt(Date.now() - 30_000);
      const db2 = counting();
      const s2 = await pollOnce({ db: db2, provider, deviceCache: cache });
      expect(s2.saved).toBe(200);
      expect(db2.n).toBe(3); // device map served from cache

      expect(events).toHaveLength(2);
      expect(events[0].insertedIds).toHaveLength(200);
      expect(events[0].vehicleIds.sort()).toEqual([...vehicleIds].sort());
      const processed = await pool.query('SELECT count(*)::int AS n FROM gps_locations WHERE id = ANY($1) AND processed_at IS NULL', [events[0].insertedIds]);
      expect(processed.rows[0].n).toBe(200); // no detection in Phase 3
    } finally {
      gpsEvents.off('ingested', onEvt);
    }
  });

  it('skips duplicates (vehicle_id, recorded_at) and never regresses the latest location with an older point', async () => {
    const provider = stubProvider();
    const cache = createDeviceCache();
    const t = Date.now() - 10_000;
    provider.records = [{ device: devices[0], lat: 28.5, lng: 77.5, at: t }];
    await pollOnce({ db: pool, provider, deviceCache: cache });

    // same point again + an older (out-of-order) point
    provider.records = [{ device: devices[0], lat: 28.5, lng: 77.5, at: t }, { device: devices[0], lat: 28.1, lng: 77.1, at: t - 120_000 }];
    const s = await pollOnce({ db: pool, provider, deviceCache: cache });
    expect(s).toMatchObject({ received: 2, saved: 1, duplicates: 1, outcome: 'SUCCESS' });

    const latest = (await pool.query('SELECT latitude, recorded_at FROM vehicle_latest_locations WHERE vehicle_id = $1', [vehicleIds[0]])).rows[0];
    expect(latest.latitude).toBe(28.5);
    expect(latest.recorded_at.getTime()).toBe(t);
    const stored = await pool.query('SELECT count(*)::int AS n FROM gps_locations WHERE vehicle_id = $1 AND recorded_at = $2', [vehicleIds[0], new Date(t - 120_000)]);
    expect(stored.rows[0].n).toBe(1); // late/out-of-order point IS stored
  });

  it('counts unknown devices and invalid points; mixed input gives PARTIAL with rejected_breakdown', async () => {
    const provider = stubProvider();
    const at = Date.now() - 5000;
    provider.records = [
      { device: devices[1], lat: 28.4, lng: 77.3, at },
      { device: 'NOT-A-DEVICE', lat: 28.4, lng: 77.3, at },
      { device: devices[2], lat: 0, lng: 0, at },
      { device: devices[3], lat: 95, lng: 77.3, at },
      { device: devices[4], lat: 28.4, lng: 77.3, at: Date.now() + 10 * 60_000 },
      { device: devices[5], lat: 28.4, lng: 77.3, at, speed: -3 },
      { device: devices[6], badTs: true },
    ];
    const s = await pollOnce({ db: pool, provider, deviceCache: createDeviceCache() });
    expect(s).toMatchObject({ outcome: 'PARTIAL', received: 7, saved: 1, rejected: 6 });
    expect(s.rejected_breakdown).toEqual({ UNKNOWN_DEVICE: 1, INVALID_COORDS: 2, FUTURE_TIMESTAMP: 1, NEGATIVE_SPEED: 1, BAD_TIMESTAMP: 1 });
    const run = (await pool.query('SELECT outcome, records_received, records_saved, records_rejected, rejected_breakdown FROM gps_poll_runs WHERE id = $1', [s.pollRunId])).rows[0];
    expect(run).toMatchObject({ outcome: 'PARTIAL', records_received: 7, records_saved: 1, records_rejected: 6 });
    expect(run.rejected_breakdown).toEqual(s.rejected_breakdown);
    const unknown = await pool.query("SELECT count(*)::int AS n FROM gps_locations WHERE device_id = 'NOT-A-DEVICE'");
    expect(unknown.rows[0].n).toBe(0);
  });

  it('chunks batches larger than 5,000 rows into multiple statements', async () => {
    const v = vehicleIds[10];
    const start = Date.now() - 7 * 24 * 3600_000;
    const points = Array.from({ length: INSERT_CHUNK + 1 }, (_, i) => ({
      vehicle_id: v, device_id: devices[10], latitude: 28.4, longitude: 77.3, speed: 5, ignition: true,
      recorded_at: new Date(start + i * 1000), provider_status: 'x', raw: { i },
    }));
    const db = counting();
    const r = await ingestBatch(db, points, { provider: 'stub' });
    expect(r.statements).toBe(2);
    expect(db.n).toBe(2);
    expect(r.insertedIds).toHaveLength(INSERT_CHUNK + 1);
  });

  it('stores raw_payload only when GPS_STORE_RAW is on, and records the provider', async () => {
    const mk = (offset) => [{ vehicle_id: vehicleIds[20], device_id: devices[20], latitude: 28.4, longitude: 77.3, speed: 1, ignition: true,
      recorded_at: new Date(Date.now() - offset), provider_status: 'x', raw: { secret: 'raw' } }];
    const off = await ingestBatch(pool, mk(1000), { provider: 'stub', storeRaw: false });
    const on = await ingestBatch(pool, mk(2000), { provider: 'stub', storeRaw: true });
    const rows = (await pool.query('SELECT id, raw_payload, provider FROM gps_locations WHERE id = ANY($1) ORDER BY id', [[...off.insertedIds, ...on.insertedIds]])).rows;
    expect(rows[0]).toMatchObject({ raw_payload: null, provider: 'stub' });
    expect(rows[1].raw_payload).toEqual({ secret: 'raw' });
  });
});

describe('advisory lock (single runner)', () => {
  it('a second instance cannot take the poll lock until the first releases it', async () => {
    const key = `${lockKeyFor()}:lock-test:${uid()}`;
    const a = createAdvisoryLock({ keyText: key });
    const b = createAdvisoryLock({ keyText: key });
    try {
      expect(await a.tryAcquire()).toBe(true);
      expect(await b.tryAcquire()).toBe(false);
      await a.release();
      expect(await b.tryAcquire()).toBe(true);
    } finally {
      await a.release();
      await b.release();
    }
  });
});

describe('simulator end-to-end (real plan from the DB)', () => {
  it('moves an assigned vehicle near its snapshot PIDs and tags points provider=simulator', async () => {
    const { route, pids } = await createRouteWithPids(4);
    const vehicle = await createVehicle();
    const today = todayInTz('Asia/Kolkata');
    const ra = (await pool.query(
      `INSERT INTO route_assignments (route_id, vehicle_id, operational_date, assigned_pid_count) VALUES ($1, $2, $3, 4) RETURNING id`,
      [route.id, vehicle.id, today])).rows[0];
    await pool.query(
      `INSERT INTO route_assignment_pids (route_assignment_id, pid_id, pid_latitude, pid_longitude)
       SELECT $1, id, latitude, longitude FROM pids WHERE id = ANY($2)`, [ra.id, pids.map((p) => p.id)]);

    const sim = createSimulatorProvider({ db: pool, config: { ...simConfigFromEnv(), jitterM: 0 }, nodeEnv: 'test' });
    const s = await pollOnce({ db: pool, provider: sim, deviceCache: createDeviceCache() });
    expect(['SUCCESS', 'PARTIAL']).toContain(s.outcome);
    const row = (await pool.query('SELECT latitude, longitude, provider FROM gps_locations WHERE vehicle_id = $1', [vehicle.id])).rows[0];
    expect(row.provider).toBe('simulator');
    // The vehicle loops through waypoints 5–15 m from the PIDs: it must be within the PIDs' bounding area.
    const nearest = Math.min(...pids.map((p) => haversineM([row.latitude, row.longitude], [p.latitude, p.longitude])));
    const span = Math.max(...pids.flatMap((a) => pids.map((b) => haversineM([a.latitude, a.longitude], [b.latitude, b.longitude]))));
    expect(nearest).toBeLessThanOrEqual(span + 20);
    expect(sim.stats.planQueries).toBe(1);
  });
});
