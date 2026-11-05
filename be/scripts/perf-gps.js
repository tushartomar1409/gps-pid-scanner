// GPS perf harness (GUIDE #6 G6). Runs ONLY in a throwaway schema and drops it afterwards.
//   DB_SCHEMA=perf_<x> npm run perf:gps [-- --keep]
// Seeds 2,000 vehicles with today's assignments (2,000 routes × 20 PIDs), runs 10 simulated poll
// cycles and reports per cycle: points, inserted, rejected, DB round trips, wall time. Then EXPLAINs
// live-vehicles (2,000 rows) and vehicle-history (1 day @ 30 s ≈ 2,880 points -> max_points 500).
const schema = process.env.DB_SCHEMA;
if (!schema || !/^(perf|test)_[a-z0-9_]+$/.test(schema)) {
  console.error('Refusing to run: set DB_SCHEMA to a throwaway schema named perf_* or test_* (never public).');
  process.exit(1);
}
process.env.LOG_LEVEL = 'silent';
const KEEP = process.argv.includes('--keep');
const VEHICLES = 2000;
const PIDS_PER_ROUTE = 20;

const { default: pg } = await import('pg');
const { buildConnectionConfig, pool, closePool } = await import('../src/config/database.js');
const { runMigrations } = await import('../src/db/migrator.js');
const { pollOnce, createDeviceCache } = await import('../src/services/gps/gpsTrackerService.js');
const { createSimulatorProvider, simConfigFromEnv } = await import('../src/services/gps/providers/simulatorProvider.js');
const { buildLiveQuery, buildHistoryQuery } = await import('../src/services/gps/gpsReadService.js');
const { todayInTz } = await import('../src/utils/time.js');

const admin = new pg.Pool(buildConnectionConfig({ schema: undefined }));
const ms = (t0) => Math.round(performance.now() - t0);
const explain = async (q) => (await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${q.text}`, q.values)).rows.map((r) => r['QUERY PLAN']).join('\n');

try {
  console.log(`== schema ${schema}`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runMigrations(pool);
  const rtt = [];
  for (let i = 0; i < 8; i++) { const t = performance.now(); await pool.query('SELECT 1'); rtt.push(performance.now() - t); } // eslint-disable-line no-await-in-loop
  rtt.sort((a, b) => a - b);
  console.log(`DB round trip (SELECT 1): median ${rtt[4].toFixed(0)} ms`);

  // ---- seed (set-based)
  let t0 = performance.now();
  const today = todayInTz('Asia/Kolkata');
  await pool.query("INSERT INTO zones (zone_code, zone_name) VALUES ('GZ', 'GPS Perf Zone')");
  await pool.query(`INSERT INTO wards (zone_id, ward_number, ward_name)
                    SELECT (SELECT id FROM zones WHERE zone_code = 'GZ'), 'W' || g, 'Ward ' || g FROM generate_series(1, 20) g`);
  await pool.query(`
    WITH w AS (SELECT array_agg(id ORDER BY id) AS ids, min(zone_id) AS zid FROM wards)
    INSERT INTO routes (route_code, route_name, zone_id, ward_id)
    SELECT 'GR' || lpad(g::text, 4, '0'), 'Route ' || g, w.zid, w.ids[(g - 1) % 20 + 1] FROM generate_series(1, ${VEHICLES}) g, w`);
  await pool.query(`
    INSERT INTO pids (pid_number, zone_id, ward_id, latitude, longitude, coord_status)
    SELECT 'GP' || r.id || '-' || k, r.zone_id, r.ward_id,
           round((28.30 + (r.id % 50) * 0.004 + k * 0.0003)::numeric, 7),
           round((77.20 + (r.id / 50) * 0.004 + k * 0.0002)::numeric, 7), 'IMPORTED'
      FROM routes r, generate_series(1, ${PIDS_PER_ROUTE}) k`);
  await pool.query(`INSERT INTO route_pids (route_id, pid_id, sequence_no)
                    SELECT r.id, p.id, row_number() OVER (PARTITION BY r.id ORDER BY p.id)
                      FROM routes r JOIN pids p ON p.pid_number LIKE 'GP' || r.id || '-%'`);
  await pool.query(`INSERT INTO vehicles (vehicle_number, vehicle_type, gps_device_id)
                    SELECT 'GV' || lpad(g::text, 4, '0'), 'Tipper', 'IMEI' || lpad(g::text, 6, '0') FROM generate_series(1, ${VEHICLES}) g`);
  await pool.query(`INSERT INTO route_assignments (route_id, vehicle_id, operational_date, assigned_pid_count)
                    SELECT r.id, v.id, $1::date, ${PIDS_PER_ROUTE}
                      FROM routes r JOIN vehicles v ON substr(v.vehicle_number, 3) = substr(r.route_code, 3)`, [today]);
  await pool.query(`INSERT INTO route_assignment_pids (route_assignment_id, pid_id, pid_latitude, pid_longitude)
                    SELECT ra.id, p.id, p.latitude, p.longitude
                      FROM route_assignments ra JOIN route_pids rp ON rp.route_id = ra.route_id JOIN pids p ON p.id = rp.pid_id`);
  await pool.query('ANALYZE');
  const counts = (await pool.query(`SELECT (SELECT count(*) FROM vehicles) v, (SELECT count(*) FROM pids) p,
                                           (SELECT count(*) FROM route_assignments) ra, (SELECT count(*) FROM route_assignment_pids) rap`)).rows[0];
  console.log(`Seeded ${counts.v} vehicles, ${counts.p} PIDs, ${counts.ra} assignments, ${counts.rap} snapshot rows in ${ms(t0)} ms`);

  // ---- 10 poll cycles: simulator with every edge case on
  const sim = createSimulatorProvider({
    db: pool, nodeEnv: 'test',
    config: { ...simConfigFromEnv(), dropoutPct: 2, duplicatePct: 2, outOfOrderPct: 2, latePct: 2, badPct: 1,
      offlineVehicles: Array.from({ length: 10 }, (_, i) => `GV${String(i + 1).padStart(4, '0')}`) },
  });
  const cache = createDeviceCache();
  const rows = [];
  for (let c = 1; c <= 10; c++) {
    const db = { n: 0, query(text, params) { db.n++; return pool.query(text, params); } };
    const planBefore = sim.stats.planQueries;
    t0 = performance.now();
    const s = await pollOnce({ db, provider: sim, deviceCache: cache }); // eslint-disable-line no-await-in-loop
    rows.push({
      cycle: c, outcome: s.outcome, points: s.received, inserted: s.saved, rejected: s.rejected, duplicates: s.duplicates,
      db_round_trips: db.n, sim_plan_queries: sim.stats.planQueries - planBefore, wall_ms: ms(t0),
    });
  }
  console.log('\n== Poll cycles (simulator: dropout 2%, dup 2%, out-of-order 2%, late 2%, bad 1%, 10 offline)');
  console.table(rows);
  const latest = (await pool.query('SELECT count(*) FROM vehicle_latest_locations')).rows[0].count;
  console.log(`vehicle_latest_locations rows: ${latest}`);

  // ---- EXPLAIN live-vehicles (2,000 rows)
  const live = buildLiveQuery({}, { unrestricted: true }, { offlineS: 300, today });
  const liveRows = (await pool.query(live.text, live.values)).rows.length;
  t0 = performance.now(); await pool.query(live.text, live.values); const liveMs = ms(t0);
  console.log(`\n== live-vehicles: ${liveRows} rows, query wall ${liveMs} ms (incl. 1 RTT)`);
  console.log(await explain(live));

  // ---- EXPLAIN vehicle-history: one day at 30 s
  const vid = (await pool.query("SELECT id FROM vehicles WHERE vehicle_number = 'GV1000'")).rows[0].id;
  const dayStart = new Date(`${today}T00:00:00+05:30`);
  await pool.query(`INSERT INTO gps_locations (vehicle_id, device_id, latitude, longitude, recorded_at, provider)
                    SELECT $1, 'IMEI001000', 28.4 + g * 0.00001, 77.3, $2::timestamptz + make_interval(secs => g * 30), 'perf'
                      FROM generate_series(0, 2879) g ON CONFLICT DO NOTHING`, [vid, dayStart]);
  await pool.query('ANALYZE gps_locations');
  const hist = buildHistoryQuery(vid, dayStart, new Date(dayStart.getTime() + 24 * 3600_000 - 1), 500);
  const histRows = (await pool.query(hist.text, hist.values)).rows;
  console.log(`\n== vehicle-history: total_in_window ${histRows[0]?.total}, returned ${histRows.length} (max_points 500), first ${histRows[0]?.recorded_at.toISOString()}, last ${histRows.at(-1)?.recorded_at.toISOString()}`);
  console.log(await explain(hist));
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
