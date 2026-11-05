// Report export memory/time harness (GUIDE #10 E5). Throwaway schema only; dropped afterwards.
//   DB_SCHEMA=perf_<x> npm run perf:reports [-- --keep] [-- --rows=100000]
// Seeds N daily-coverage rows (1,000 assignments × N/1,000 PIDs, with visit events on 30 %), then streams the
// daily-coverage export as XLSX and CSV into a byte-counting sink, sampling RSS every 25 ms.
const schema = process.env.DB_SCHEMA;
if (!schema || !/^(perf|test)_[a-z0-9_]+$/.test(schema)) {
  console.error('Refusing to run: set DB_SCHEMA to a throwaway schema named perf_* or test_* (never public).');
  process.exit(1);
}
process.env.LOG_LEVEL = 'silent';
const KEEP = process.argv.includes('--keep');
const ROWS = Number((process.argv.find((a) => a.startsWith('--rows=')) || '--rows=100000').split('=')[1]);
const ASSIGNMENTS = 1000;
const PER = Math.ceil(ROWS / ASSIGNMENTS);

const { Writable } = await import('node:stream');
const { default: pg } = await import('pg');
const { buildConnectionConfig, pool, closePool } = await import('../src/config/database.js');
const { runMigrations } = await import('../src/db/migrator.js');
const { prepare, buildMeta, writeReport } = await import('../src/services/reports/reportService.js');

const admin = new pg.Pool(buildConnectionConfig({ schema: undefined }));
const ms = (t0) => Math.round(performance.now() - t0);
const MB = (b) => Math.round((b / 1048576) * 10) / 10;
const DATE = '2031-01-15';

/** gcEvery: force a full GC every N rows (diagnostic: separates retained memory from uncollected garbage). */
async function measure(format, { gcEvery = 0 } = {}) {
  global.gc?.();
  const m0 = process.memoryUsage();
  const base = m0.rss;
  let peak = base;
  let heapPeak = m0.heapUsed;
  let abPeak = m0.arrayBuffers;
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    peak = Math.max(peak, m.rss); heapPeak = Math.max(heapPeak, m.heapUsed); abPeak = Math.max(abPeak, m.arrayBuffers);
  }, 25);
  let bytes = 0;
  const sink = new Writable({ write(chunk, _enc, cb) { bytes += chunk.length; setImmediate(cb); } }); // async sink ≈ a network socket
  const t0 = performance.now();
  const { def, q } = prepare('daily-coverage', { date: DATE });
  const meta = await buildMeta(def, q, { unrestricted: true }, null);
  let seen = 0;
  const target = gcEvery ? new Proxy(sink, { get: (t, k) => (k === 'write' ? (c, ...a) => { if (++seen % gcEvery === 0) global.gc?.(); return t.write(c, ...a); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }) : sink;
  const rows = await writeReport(def, q, { unrestricted: true }, format, gcEvery ? target : sink, meta);
  if (!sink.writableFinished) await new Promise((r) => sink.once('finish', r));
  const wall = ms(t0);
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().rss);
  return { format: gcEvery ? `${format} (gc/${gcEvery})` : format, rows, bytes_mb: MB(bytes), wall_ms: wall, rows_per_s: Math.round(rows / (wall / 1000)),
    rss_growth_mb: MB(peak - base), heap_growth_mb: MB(heapPeak - m0.heapUsed), arraybuf_growth_mb: MB(abPeak - m0.arrayBuffers) };
}

try {
  console.log(`== schema ${schema}, ${ROWS.toLocaleString()} rows`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runMigrations(pool);
  let t0 = performance.now();
  await pool.query("INSERT INTO zones (zone_code, zone_name) VALUES ('RZ', 'Report Perf')");
  await pool.query("INSERT INTO wards (zone_id, ward_number, ward_name) SELECT (SELECT id FROM zones), 'W' || g, 'Ward ' || g FROM generate_series(1, 20) g");
  await pool.query("INSERT INTO agencies (agency_name) SELECT 'Agency ' || g FROM generate_series(1, 10) g");
  await pool.query(`WITH w AS (SELECT array_agg(id ORDER BY id) ids, min(zone_id) zid FROM wards)
    INSERT INTO routes (route_code, route_name, zone_id, ward_id) SELECT 'RR' || lpad(g::text, 4, '0'), 'R' || g, w.zid, w.ids[(g - 1) % 20 + 1] FROM generate_series(1, ${ASSIGNMENTS}) g, w`);
  await pool.query(`INSERT INTO vehicles (vehicle_number, vehicle_type, gps_device_id, agency_id)
    SELECT 'RV' || lpad(g::text, 4, '0'), 'Tipper', 'RIMEI' || g, (SELECT min(id) FROM agencies) + (g % 10) FROM generate_series(1, ${ASSIGNMENTS}) g`);
  await pool.query(`INSERT INTO pids (pid_number, zone_id, ward_id, latitude, longitude, coord_status, address)
    SELECT 'RP' || r.id || '-' || k, r.zone_id, r.ward_id, 28.3 + (r.id % 50) * 0.006, 77.2 + k * 0.00025, 'IMPORTED',
           CASE WHEN k % 5 = 0 THEN 'मकान नं. ' || k || ', सेक्टर ' || (r.id % 40) || ', फरीदाबाद' ELSE 'House ' || k || ', Sector ' || (r.id % 40) || ', Faridabad, Haryana' END
      FROM routes r, generate_series(1, ${PER}) k`);
  await pool.query(`INSERT INTO route_assignments (route_id, vehicle_id, agency_id, operational_date, assigned_pid_count)
    SELECT r.id, v.id, v.agency_id, '${DATE}', ${PER} FROM routes r JOIN vehicles v ON substr(v.vehicle_number, 3) = substr(r.route_code, 3)`);
  await pool.query(`INSERT INTO route_assignment_pids (route_assignment_id, pid_id, pid_latitude, pid_longitude)
    SELECT ra.id, p.id, p.latitude, p.longitude FROM route_assignments ra JOIN routes r ON r.id = ra.route_id JOIN pids p ON p.pid_number LIKE 'RP' || r.id || '-%'`);
  await pool.query(`INSERT INTO pid_daily_status (operational_date, route_assignment_id, pid_id, vehicle_id, visit_status, first_visit_at, last_visit_at, min_distance_meters)
    SELECT '${DATE}', rap.route_assignment_id, rap.pid_id, ra.vehicle_id,
           (ARRAY['GPS_VISIT_CONFIRMED','GPS_VISIT_CANDIDATE','NOT_VISITED','NOT_VISITED'])[1 + rap.pid_id % 4],
           CASE WHEN rap.pid_id % 4 < 2 THEN '${DATE}T04:00:00Z'::timestamptz END, CASE WHEN rap.pid_id % 4 < 2 THEN '${DATE}T04:01:00Z'::timestamptz END,
           CASE WHEN rap.pid_id % 4 < 2 THEN 8 + rap.pid_id % 20 END
      FROM route_assignment_pids rap JOIN route_assignments ra ON ra.id = rap.route_assignment_id`);
  // One GPS point per vehicle + events for 30 % of PIDs (so the evidence LATERAL does real work).
  await pool.query(`INSERT INTO gps_locations (vehicle_id, device_id, latitude, longitude, speed, recorded_at, received_at, provider, processed_at)
    SELECT id, gps_device_id, 28.4, 77.3, 10, '${DATE}T04:00:00Z', '${DATE}T04:00:05Z', 'perf', now() FROM vehicles`);
  await pool.query(`INSERT INTO pid_visit_events (route_assignment_id, pid_id, vehicle_id, gps_location_id, distance_meters, detected_at, evidence_status)
    SELECT s.route_assignment_id, s.pid_id, s.vehicle_id, g.id, 10, g.recorded_at, CASE WHEN s.pid_id % 2 = 0 THEN 'PROXIMITY_POINT' ELSE 'TRACK_SEGMENT' END
      FROM pid_daily_status s JOIN gps_locations g ON g.vehicle_id = s.vehicle_id WHERE s.pid_id % 10 < 3`);
  await pool.query('ANALYZE');
  const n = (await pool.query('SELECT count(*)::int n FROM pid_daily_status')).rows[0].n;
  console.log(`Seeded ${n.toLocaleString()} daily statuses in ${ms(t0)} ms`);

  const results = [];
  for (const f of ['xlsx', 'csv']) results.push(await measure(f)); // eslint-disable-line no-await-in-loop
  if (process.argv.includes('--diagnose')) results.push(await measure('xlsx', { gcEvery: 50 }));
  console.log('\n== daily-coverage export (streamed into an async sink)');
  console.table(results);
  t0 = performance.now();
  const { def, q } = prepare('daily-coverage', { date: DATE });
  const { orderedSql } = await import('../src/services/reports/definitions.js');
  const b = def.build(q, { unrestricted: true });
  const { rows: plan } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${orderedSql(def, b)}`, b.values);
  console.log(`\n== EXPLAIN ANALYZE daily-coverage (${ms(t0)} ms incl. RTT)`);
  console.log(plan.map((r) => r['QUERY PLAN']).filter((l) => /Execution Time|Sort Method|Seq Scan|Index|Nested Loop|Hash Join|Memoize/.test(l)).slice(0, 25).join('\n'));
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
