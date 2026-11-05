// Detection recall experiment (GUIDE #7 H6). Throwaway schema only; dropped afterwards.
//   DB_SCHEMA=perf_<x> npm run recall [-- --keep]
//
// Ground-truth world: 20 straight streets (1.2 km, far apart). 100 PIDs per street every 12 m along it,
// alternating sides, setbacks cycling 10/18/26/34/42 m from the centreline. A PID is TRULY PASSED when its
// setback ≤ radius (the vehicle drives the centreline). PIDs at 34/42 m are the "neighbouring property on
// a dense street" that must NOT be confirmed at radius 30.
// The vehicle drives at 15 km/h; GPS points every Δt with uniform-disc jitter. The REAL detection engine
// (SQL) runs for each confirmation mode. A JS "segment-based" estimate (track line within radius) is
// reported alongside for comparison.
const schema = process.env.DB_SCHEMA;
if (!schema || !/^(perf|test)_[a-z0-9_]+$/.test(schema)) {
  console.error('Refusing to run: set DB_SCHEMA to a throwaway schema named perf_* or test_* (never public).');
  process.exit(1);
}
process.env.LOG_LEVEL = 'silent';
const KEEP = process.argv.includes('--keep');

const { default: pg } = await import('pg');
const { buildConnectionConfig, pool, closePool } = await import('../src/config/database.js');
const { runMigrations } = await import('../src/db/migrator.js');
const { runDetection } = await import('../src/services/pidDetectionService.js');
const { loadDetectionSettings } = await import('../src/services/settingsDefinitions.js');
const { offsetM, rngForTest } = await (async () => {
  const g = await import('../src/services/gps/geoMath.js');
  const s = await import('../src/services/gps/providers/simulatorProvider.js');
  return { offsetM: g.offsetM, rngForTest: s.rngFor };
})();
const { addDays, todayInTz } = await import('../src/utils/time.js');

const STREETS = 20;
const PIDS_PER_STREET = 100;
const SPACING_M = 12;
const SETBACKS = [10, 18, 26, 34, 42];
const SPEED_MPS = 15 / 3.6;
const PATH_FROM = -100;
const PATH_TO = 1300;
const MODES = [
  { key: 'consecutive_points', label: 'consecutive N=2', s: { confirmationMode: 'consecutive_points', consecutivePoints: 2 } },
  { key: 'min_events', label: 'min_events N=2/300s', s: { confirmationMode: 'min_events', consecutivePoints: 2, confirmationWindowS: 300 } },
  { key: 'dwell', label: 'dwell 20s', s: { confirmationMode: 'dwell', minDwellSeconds: 20 } },
];
// --segments: re-run the 30 s rows with TRACK_SEGMENT evidence ON (GUIDE #8). Default run: segments OFF,
// so the baseline table stays comparable with the Phase 4 report.
const SEGMENTS = process.argv.includes('--segments');
let CELLS = [];
for (const interval of [10, 30, 60]) for (const jitter of [5, 10, 20]) CELLS.push({ interval, jitter, radius: 30, stops: false });
CELLS.push({ interval: 30, jitter: 10, radius: 50, stops: false });
CELLS.push({ interval: 30, jitter: 10, radius: 30, stops: true }); // collection stops: 30 s every 60 m
if (SEGMENTS) CELLS = CELLS.filter((c) => c.interval === 30);

const admin = new pg.Pool(buildConnectionConfig({ schema: undefined }));
const streetOrigin = (s) => [28.30 + s * 0.005, 77.20];
const local = (s, x, y) => offsetM(streetOrigin(s), y, x); // x along (east), y north

/** Vehicle position along the street at `elapsed` seconds (optionally with collection stops). */
function xAt(elapsed, stops) {
  if (!stops) return PATH_FROM + SPEED_MPS * elapsed;
  const drive = 60 / SPEED_MPS;
  const cycle = drive + 30;
  const n = Math.floor(elapsed / cycle);
  const r = elapsed - n * cycle;
  return PATH_FROM + n * 60 + Math.min(r, drive) * SPEED_MPS;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

try {
  console.log(`== schema ${schema}`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runMigrations(pool);

  // ---- world
  await pool.query("INSERT INTO zones (zone_code, zone_name) VALUES ('RZ', 'Recall')");
  await pool.query("INSERT INTO wards (zone_id, ward_number, ward_name) VALUES ((SELECT id FROM zones), 'R1', 'Recall ward')");
  const { zone_id: zoneId, id: wardId } = (await pool.query('SELECT id, zone_id FROM wards')).rows[0];
  const pidMeta = new Map(); // pid_id -> { street, x, y, setback }
  const routeIds = []; const vehicleIds = [];
  for (let s = 0; s < STREETS; s++) {
    const pts = Array.from({ length: PIDS_PER_STREET }, (_, k) => {
      const setback = SETBACKS[k % SETBACKS.length];
      const y = (k % 2 ? 1 : -1) * setback;
      const [lat, lng] = local(s, k * SPACING_M, y);
      return { k, x: k * SPACING_M, y, setback, lat, lng };
    });
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await pool.query(
      `INSERT INTO pids (pid_number, zone_id, ward_id, latitude, longitude, coord_status)
       SELECT 'RC-' || $1 || '-' || k, $2, $3, la, lo, 'IMPORTED' FROM unnest($4::int[], $5::numeric[], $6::numeric[]) t(k, la, lo)
       RETURNING id, pid_number`,
      [s, zoneId, wardId, pts.map((p) => p.k), pts.map((p) => p.lat.toFixed(7)), pts.map((p) => p.lng.toFixed(7))]);
    for (const r of rows) {
      const k = Number(r.pid_number.split('-')[2]);
      pidMeta.set(Number(r.id), { street: s, ...pts[k] });
    }
    // eslint-disable-next-line no-await-in-loop
    const route = (await pool.query("INSERT INTO routes (route_code, route_name, zone_id, ward_id) VALUES ($1, 'street', $2, $3) RETURNING id", [`RS${s}`, zoneId, wardId])).rows[0];
    // eslint-disable-next-line no-await-in-loop
    await pool.query('INSERT INTO route_pids (route_id, pid_id, sequence_no) SELECT $1, id, row_number() OVER (ORDER BY id) FROM unnest($2::bigint[]) id', [route.id, rows.map((r) => r.id)]);
    // eslint-disable-next-line no-await-in-loop
    const v = (await pool.query("INSERT INTO vehicles (vehicle_number, vehicle_type, gps_device_id) VALUES ($1, 'Tipper', $2) RETURNING id", [`RV${s}`, `RDEV${s}`])).rows[0];
    routeIds.push(route.id);
    vehicleIds.push(v.id);
  }
  console.log(`World: ${STREETS} streets × ${PIDS_PER_STREET} PIDs, setbacks ${SETBACKS.join('/')} m`);

  const results = [];
  for (const [ci, cell] of CELLS.entries()) {
    const date = addDays(todayInTz('Asia/Kolkata'), 100 + ci);
    // assignments + snapshot + statuses for this cell's date
    // eslint-disable-next-line no-await-in-loop
    const ras = (await pool.query(
      `INSERT INTO route_assignments (route_id, vehicle_id, operational_date, assigned_pid_count)
       SELECT r, v, $3::date, ${PIDS_PER_STREET} FROM unnest($1::int[], $2::int[]) t(r, v) RETURNING id, route_id, vehicle_id`,
      [routeIds, vehicleIds, date])).rows;
    const raIds = ras.map((r) => r.id);
    // eslint-disable-next-line no-await-in-loop
    await pool.query(`INSERT INTO route_assignment_pids (route_assignment_id, pid_id, pid_latitude, pid_longitude)
      SELECT ra.id, p.id, p.latitude, p.longitude FROM route_assignments ra JOIN route_pids rp ON rp.route_id = ra.route_id JOIN pids p ON p.id = rp.pid_id
       WHERE ra.id = ANY($1)`, [raIds]);
    // eslint-disable-next-line no-await-in-loop
    await pool.query(`INSERT INTO pid_daily_status (operational_date, route_assignment_id, pid_id, vehicle_id, visit_status)
      SELECT $2::date, rap.route_assignment_id, rap.pid_id, ra.vehicle_id, 'NOT_VISITED'
        FROM route_assignment_pids rap JOIN route_assignments ra ON ra.id = rap.route_assignment_id WHERE ra.id = ANY($1)`, [raIds, date]);

    // tracks
    const cols = [[], [], [], [], []];
    const trackLocal = new Map(); // street -> [[x,y],...]
    for (let s = 0; s < STREETS; s++) {
      const rnd = rngForTest('recall', ci, s);
      const t0 = new Date(`${date}T09:00:00+05:30`).getTime() + s * 60_000;
      const phase = rnd() * cell.interval;
      const tl = [];
      for (let i = 0; ; i++) {
        const el = phase + i * cell.interval;
        const x = xAt(el, cell.stops);
        if (x > PATH_TO) break;
        const rr = cell.jitter * Math.sqrt(rnd());
        const a = rnd() * 2 * Math.PI;
        const [jx, jy] = [rr * Math.cos(a), rr * Math.sin(a)];
        const [lat, lng] = local(s, x + jx, jy);
        tl.push([x + jx, jy]);
        cols[0].push(vehicleIds[s]); cols[1].push(lat.toFixed(7)); cols[2].push(lng.toFixed(7));
        cols[3].push(new Date(t0 + el * 1000)); cols[4].push(15); // no speed gate in this experiment
      }
      trackLocal.set(s, tl);
    }
    // eslint-disable-next-line no-await-in-loop
    const ptIds = (await pool.query(
      `INSERT INTO gps_locations (vehicle_id, device_id, latitude, longitude, recorded_at, received_at, speed, provider)
       SELECT v, 'R', la, lo, ra, ra + interval '5 seconds', sp, 'recall' FROM unnest($1::int[], $2::numeric[], $3::numeric[], $4::timestamptz[], $5::numeric[]) t(v, la, lo, ra, sp)
       RETURNING id`, cols)).rows.map((r) => r.id);

    // JS segment-based estimate (same truth)
    let segPassed = 0; let segFalse = 0; let truePassedN = 0; let notPassedN = 0;
    for (const [, m] of pidMeta) {
      const tl = trackLocal.get(m.street);
      let best = Infinity;
      for (let i = 1; i < tl.length; i++) best = Math.min(best, segDist(m.x, m.y, tl[i - 1][0], tl[i - 1][1], tl[i][0], tl[i][1]));
      const truly = m.setback <= cell.radius;
      if (truly) { truePassedN++; if (best <= cell.radius) segPassed++; } else { notPassedN++; if (best <= cell.radius) segFalse++; }
    }

    for (const mode of MODES) {
      // eslint-disable-next-line no-await-in-loop
      const settings = await loadDetectionSettings(pool, {
        radiusM: cell.radius, latePointsPolicy: 'accept', minSpeedKmh: null, maxSpeedKmh: null,
        segmentEvidenceEnabled: SEGMENTS, segmentMaxLengthM: 200, segmentMaxGapS: 90, ...mode.s,
      });
      // eslint-disable-next-line no-await-in-loop
      await runDetection(pool, settings, { emit: false });
      // eslint-disable-next-line no-await-in-loop
      const st = (await pool.query('SELECT pid_id, visit_status FROM pid_daily_status WHERE route_assignment_id = ANY($1)', [raIds])).rows;
      const c = { tp: { CONF: 0, CAND: 0, MISS: 0 }, np: { CONF: 0, ANY: 0 } };
      for (const r of st) {
        const truly = pidMeta.get(Number(r.pid_id)).setback <= cell.radius;
        const conf = r.visit_status === 'GPS_VISIT_CONFIRMED';
        const cand = r.visit_status === 'GPS_VISIT_CANDIDATE';
        if (truly) c.tp[conf ? 'CONF' : cand ? 'CAND' : 'MISS']++;
        else { if (conf) c.np.CONF++; if (conf || cand) c.np.ANY++; }
      }
      const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
      results.push({
        interval_s: cell.interval, jitter_m: cell.jitter, radius_m: cell.radius, stops: cell.stops ? 'yes' : 'no', mode: mode.label,
        confirmed_pct: pct(c.tp.CONF, truePassedN), candidate_pct: pct(c.tp.CAND, truePassedN), missed_pct: pct(c.tp.MISS, truePassedN),
        false_confirmed_pct: pct(c.np.CONF, notPassedN), false_any_pct: pct(c.np.ANY, notPassedN),
        segment_detect_pct: pct(segPassed, truePassedN), segment_false_pct: pct(segFalse, notPassedN),
        points_per_street: Math.round(ptIds.length / STREETS),
      });
      // reset derived data for the next mode (derived only; raw points kept)
      // eslint-disable-next-line no-await-in-loop
      await pool.query('DELETE FROM pid_visit_events WHERE route_assignment_id = ANY($1)', [raIds]);
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`UPDATE pid_daily_status SET visit_status = 'NOT_VISITED', first_visit_at = NULL, last_visit_at = NULL, detection_count = 0,
                          min_distance_meters = NULL, best_event_id = NULL, confirmed_at = NULL, ambiguous = false WHERE route_assignment_id = ANY($1)`, [raIds]);
      // eslint-disable-next-line no-await-in-loop
      await pool.query('UPDATE gps_locations SET processed_at = NULL WHERE id = ANY($1)', [ptIds]);
    }
    // this cell is done: mark its points processed so they never mix into the next cell
    // eslint-disable-next-line no-await-in-loop
    await pool.query('UPDATE gps_locations SET processed_at = now() WHERE id = ANY($1)', [ptIds]);
    console.log(`cell ${ci + 1}/${CELLS.length} done (${cell.interval}s / ${cell.jitter}m / r${cell.radius}${cell.stops ? ' / stops' : ''})`);
  }

  console.log(`\n== RESULTS — segment evidence ${SEGMENTS ? 'ON' : 'OFF'} (truly passed = setback ≤ radius; false = PIDs NOT truly passed)`);
  console.table(results);
  console.log('\nMARKDOWN');
  console.log('| Δt | jitter | radius | stops | mode | confirmed | candidate | missed | false-confirmed | false-any | segment-based detect | segment false |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  const f = (v) => (v === null ? 'n/a' : `${v}%`);
  for (const r of results) {
    console.log(`| ${r.interval_s}s | ${r.jitter_m}m | ${r.radius_m}m | ${r.stops} | ${r.mode} | ${f(r.confirmed_pct)} | ${f(r.candidate_pct)} | ${f(r.missed_pct)} | ${f(r.false_confirmed_pct)} | ${f(r.false_any_pct)} | ${f(r.segment_detect_pct)} | ${f(r.segment_false_pct)} |`);
  }
} catch (err) {
  console.error('RECALL RUN FAILED:', err);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
  if (!KEEP) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    console.log(`\nDropped schema ${schema}`);
  } else console.log(`\nKept schema ${schema} (--keep)`);
  await admin.end();
}
