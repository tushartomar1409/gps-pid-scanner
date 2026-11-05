// Detection perf harness (GUIDE #7 H5). Throwaway schema only; dropped afterwards.
//   DB_SCHEMA=perf_<x> npm run perf:detect [-- --keep]
// 2,000 vehicles × 20 snapshot PIDs (40,000) -> 10 simulated poll cycles (30 s apart) -> detection.
// Reports per batch: points, events, status changes, DB round trips, wall time; then EXPLAIN ANALYZE of a
// real batch (inside a rolled-back transaction) to show the candidate join using idx_rap_ra_lat_lng.
const schema = process.env.DB_SCHEMA;
if (!schema || !/^(perf|test)_[a-z0-9_]+$/.test(schema)) {
  console.error('Refusing to run: set DB_SCHEMA to a throwaway schema named perf_* or test_* (never public).');
  process.exit(1);
}
process.env.LOG_LEVEL = 'silent';
const KEEP = process.argv.includes('--keep');
const N = 2000;

const { default: pg } = await import('pg');
const { buildConnectionConfig, pool, closePool } = await import('../src/config/database.js');
const { runMigrations } = await import('../src/db/migrator.js');
const { pollOnce, createDeviceCache } = await import('../src/services/gps/gpsTrackerService.js');
const { createSimulatorProvider, simConfigFromEnv } = await import('../src/services/gps/providers/simulatorProvider.js');
const { detectBatch, CLAIM_AND_DETECT_SQL, RECOMPUTE_SQL } = await import('../src/services/pidDetectionService.js');
const { loadDetectionSettings } = await import('../src/services/settingsDefinitions.js');
const { M_PER_DEG_LAT, MIN_COS_LAT } = await import('../src/utils/haversine.js');
const { todayInTz } = await import('../src/utils/time.js');

const admin = new pg.Pool(buildConnectionConfig({ schema: undefined }));
const ms = (t0) => Math.round(performance.now() - t0);

try {
  console.log(`== schema ${schema}`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runMigrations(pool);
  const today = todayInTz('Asia/Kolkata');

  let t0 = performance.now();
  await pool.query("INSERT INTO zones (zone_code, zone_name) VALUES ('DZ', 'Detect Perf')");
  await pool.query("INSERT INTO wards (zone_id, ward_number, ward_name) SELECT (SELECT id FROM zones), 'W' || g, 'Ward ' || g FROM generate_series(1, 20) g");
  await pool.query(`WITH w AS (SELECT array_agg(id ORDER BY id) ids, min(zone_id) zid FROM wards)
    INSERT INTO routes (route_code, route_name, zone_id, ward_id) SELECT 'DR' || lpad(g::text, 4, '0'), 'R' || g, w.zid, w.ids[(g - 1) % 20 + 1] FROM generate_series(1, ${N}) g, w`);
  // 20 PIDs per route spaced ~25 m along a short street; routes laid out on a grid.
  await pool.query(`INSERT INTO pids (pid_number, zone_id, ward_id, latitude, longitude, coord_status)
    SELECT 'DP' || r.id || '-' || k, r.zone_id, r.ward_id,
           round((28.30 + (r.id % 50) * 0.006)::numeric, 7), round((77.20 + (r.id / 50) * 0.006 + k * 0.00025)::numeric, 7), 'IMPORTED'
      FROM routes r, generate_series(1, 20) k`);
  await pool.query(`INSERT INTO route_pids (route_id, pid_id, sequence_no)
    SELECT r.id, p.id, row_number() OVER (PARTITION BY r.id ORDER BY p.id) FROM routes r JOIN pids p ON p.pid_number LIKE 'DP' || r.id || '-%'`);
  await pool.query(`INSERT INTO vehicles (vehicle_number, vehicle_type, gps_device_id)
    SELECT 'DV' || lpad(g::text, 4, '0'), 'Tipper', 'DIMEI' || lpad(g::text, 6, '0') FROM generate_series(1, ${N}) g`);
  await pool.query(`INSERT INTO route_assignments (route_id, vehicle_id, operational_date, assigned_pid_count)
    SELECT r.id, v.id, $1::date, 20 FROM routes r JOIN vehicles v ON substr(v.vehicle_number, 3) = substr(r.route_code, 3)`, [today]);
  await pool.query(`INSERT INTO route_assignment_pids (route_assignment_id, pid_id, pid_latitude, pid_longitude)
    SELECT ra.id, p.id, p.latitude, p.longitude FROM route_assignments ra JOIN route_pids rp ON rp.route_id = ra.route_id JOIN pids p ON p.id = rp.pid_id`);
  await pool.query(`INSERT INTO pid_daily_status (operational_date, route_assignment_id, pid_id, vehicle_id, visit_status)
    SELECT $1::date, rap.route_assignment_id, rap.pid_id, ra.vehicle_id, 'NOT_VISITED'
      FROM route_assignment_pids rap JOIN route_assignments ra ON ra.id = rap.route_assignment_id`, [today]);
  await pool.query('ANALYZE');
  console.log(`Seeded ${N} vehicles, ${N * 20} snapshot PIDs + daily statuses in ${ms(t0)} ms`);

  // 10 poll cycles at simulated 30 s spacing (ending ~now), jitter 8 m.
  let simNow = Date.now() - 10 * 30_000;
  const sim = createSimulatorProvider({ db: pool, nodeEnv: 'test', now: () => new Date(simNow), config: { ...simConfigFromEnv(), jitterM: 8 } });
  const cache = createDeviceCache();
  t0 = performance.now();
  let ingested = 0;
  for (let c = 0; c < 10; c++) {
    simNow += 30_000;
    ingested += (await pollOnce({ db: pool, provider: sim, deviceCache: cache })).saved; // eslint-disable-line no-await-in-loop
  }
  console.log(`Ingested ${ingested} points over 10 simulated cycles in ${ms(t0)} ms`);

  // Detection: perf settings accept late points (cycles are back-dated up to 5 min).
  const settings = await loadDetectionSettings(pool, { latePointsPolicy: 'accept' });
  const rows = [];
  for (let b = 1; ; b++) {
    let rt = 0;
    const qt = {};
    t0 = performance.now();
    const r = await detectBatch(pool, settings, { // eslint-disable-line no-await-in-loop
      batchSize: 5000, countQuery: () => { rt++; }, onQueryTime: (k, t) => { qt[k] = Math.round(t); },
    });
    if (!r) break;
    rows.push({
      batch: b, points: r.points, events: r.events_inserted, pairs: r.affected_pairs, status_changes: r.pidStatusChanges.length,
      db_round_trips: rt, claim_ms: qt.claim, recompute_ms: qt.recompute, wall_ms: ms(t0),
    });
    if (r.points < 5000) break;
  }
  console.log('\n== Detection batches (batch size 5,000)');
  console.table(rows);
  const dist = (await pool.query("SELECT visit_status, count(*)::int n FROM pid_daily_status GROUP BY 1 ORDER BY 1")).rows;
  console.log('pid_daily_status:', dist.map((d) => `${d.visit_status}=${d.n}`).join(', '));

  // EXPLAIN ANALYZE a real 5,000-point batch, rolled back so nothing changes.
  await pool.query("UPDATE gps_locations SET processed_at = NULL WHERE id IN (SELECT id FROM gps_locations ORDER BY id LIMIT 5000)");
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: plan } = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${CLAIM_AND_DETECT_SQL}`, [
      5000, settings.timezone, settings.radiusM, settings.maxGpsAgeS, settings.latePointsPolicy, settings.minSpeedKmh, settings.maxSpeedKmh, M_PER_DEG_LAT, MIN_COS_LAT]);
    await client.query('ROLLBACK');
    console.log('\n== EXPLAIN (ANALYZE, BUFFERS) claim + detect, 5,000 points (rolled back)');
    console.log(plan.map((r) => r['QUERY PLAN']).join('\n'));

    // Recompute step for the pairs that batch touches (claim executed for real, then rolled back).
    await client.query('BEGIN');
    const { rows: [c] } = await client.query(CLAIM_AND_DETECT_SQL, [
      5000, settings.timezone, settings.radiusM, settings.maxGpsAgeS, settings.latePointsPolicy, settings.minSpeedKmh, settings.maxSpeedKmh, M_PER_DEG_LAT, MIN_COS_LAT]);
    for (const mode of ['consecutive_points', 'min_events', 'dwell']) {
      // eslint-disable-next-line no-await-in-loop
      const { rows: p2 } = await client.query(`EXPLAIN (ANALYZE) ${RECOMPUTE_SQL}`, [c.pair_ra, c.pair_pid, mode, 2, 300, 20]);
      console.log(`\n== EXPLAIN ANALYZE recompute (${c.pair_ra.length} pairs, mode ${mode}) — execution: ${p2.at(-1)['QUERY PLAN']}`);
      if (mode === 'consecutive_points') console.log(p2.map((r) => r['QUERY PLAN']).join('\n'));
    }
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
} catch (err) {
  console.error('PERF RUN FAILED:', err);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
  if (!KEEP) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    console.log(`\nDropped schema ${schema}`);
  } else console.log(`\nKept schema ${schema} (--keep)`);
  await admin.end();
}
