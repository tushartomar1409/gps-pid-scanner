// Perf harness for Phase 2a (GUIDE #4 E2). Runs ONLY in an isolated schema and drops it afterwards.
//
//   DB_SCHEMA=perf_<name> node scripts/seed-perf.js [--keep]
//
// Seeds 100,000 PIDs (2 zones, 20 wards), then measures through the real Express app (in-process):
//   1. GET /api/pids/map for a ~1 km bbox            (target < 300 ms)
//   2. POST /api/pids/import?mode=validate, 50k CSV  (target < 30 s)
//   3. POST /api/route-assignments, 2,000-PID route  (target < 2 s)
// and prints EXPLAIN (ANALYZE, BUFFERS) plans plus the DB round-trip baseline.

const schema = process.env.DB_SCHEMA;
if (!schema || !/^(perf|test)_[a-z0-9_]+$/.test(schema)) {
  console.error('Refusing to run: set DB_SCHEMA to a throwaway schema named perf_* or test_* (never public).');
  process.exit(1);
}
process.env.LOG_LEVEL = 'silent';
const KEEP = process.argv.includes('--keep');

const { default: pg } = await import('pg');
const { default: request } = await import('supertest');
const { buildConnectionConfig, pool, closePool } = await import('../src/config/database.js');
const { runMigrations } = await import('../src/db/migrator.js');
const { createApp } = await import('../src/app.js');
const { signToken } = await import('../src/services/tokenService.js');
const { buildMapQuery } = await import('../src/repositories/pidRepository.js');
const { todayInTz, addDays } = await import('../src/utils/time.js');

const admin = new pg.Pool(buildConnectionConfig({ schema: undefined }));
const ms = (t0) => Math.round(performance.now() - t0);
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const AREA = { minLat: 28.3, maxLat: 28.5, minLng: 77.2, maxLng: 77.4 }; // ~22 x 19.6 km

async function explain(text, values) {
  const { rows } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

try {
  console.log(`== schema ${schema}`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runMigrations(pool);

  // RTT baseline
  const rtt = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    await pool.query('SELECT 1'); // eslint-disable-line no-await-in-loop
    rtt.push(performance.now() - t0);
  }
  console.log(`DB round trip (SELECT 1): median ${median(rtt).toFixed(0)} ms`);

  // ---- seed
  let t0 = performance.now();
  await pool.query(`INSERT INTO zones (zone_code, zone_name) VALUES ('PZ1','Perf Zone 1'), ('PZ2','Perf Zone 2')`);
  await pool.query(`INSERT INTO wards (zone_id, ward_number, ward_name)
    SELECT z.id, 'W' || lpad(g::text, 2, '0'), 'Perf Ward ' || g
      FROM generate_series(1, 20) g JOIN zones z ON z.zone_code = CASE WHEN g <= 10 THEN 'PZ1' ELSE 'PZ2' END`);
  await pool.query(`
    WITH w AS (SELECT array_agg(id ORDER BY id) AS ids, array_agg(zone_id ORDER BY id) AS zids FROM wards)
    INSERT INTO pids (pid_number, address, zone_id, ward_id, latitude, longitude, coord_status)
    SELECT 'PERF' || lpad(g::text, 6, '0'), 'House ' || g,
           w.zids[(g - 1) % 20 + 1], w.ids[(g - 1) % 20 + 1],
           round((${AREA.minLat} + random() * ${AREA.maxLat - AREA.minLat})::numeric, 7),
           round((${AREA.minLng} + random() * ${AREA.maxLng - AREA.minLng})::numeric, 7),
           'IMPORTED'
      FROM generate_series(1, 100000) g, w`);
  await pool.query('ANALYZE pids');
  const user = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role_id) SELECT 'Perf Admin', 'perf@test.local', 'x', id FROM roles WHERE role_key = 'SUPER_ADMIN'
     RETURNING id`)).rows[0];
  const token = signToken({ id: user.id, role_key: 'SUPER_ADMIN' });
  const auth = { Authorization: `Bearer ${token}` };
  console.log(`Seeded 2 zones, 20 wards, 100,000 PIDs in ${ms(t0)} ms`);

  const app = createApp();

  // ---- 1. map, ~1 km bbox at the centre
  const c = { lat: 28.4, lng: 77.3 };
  const dLat = 0.5 / 111.32; // 500 m
  const dLng = 0.5 / (111.32 * Math.cos((c.lat * Math.PI) / 180));
  const bbox = { minLng: c.lng - dLng, minLat: c.lat - dLat, maxLng: c.lng + dLng, maxLat: c.lat + dLat };
  const bboxStr = [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat].map((v) => v.toFixed(6)).join(',');
  const mapTimes = [];
  let points = 0;
  for (let i = 0; i < 6; i++) {
    t0 = performance.now();
    const res = await request(app).get(`/api/pids/map?bbox=${bboxStr}`).set(auth); // eslint-disable-line no-await-in-loop
    if (i > 0) mapTimes.push(ms(t0)); // first call warms the pool
    points = res.body.data.count;
  }
  const mq = buildMapQuery({ bbox, limit: 5000, scope: { unrestricted: true } });
  console.log(`\n== 1. GET /api/pids/map (~1 km bbox): ${points} points, HTTP median ${median(mapTimes)} ms (min ${Math.min(...mapTimes)})`);
  console.log(await explain(mq.text, mq.values));

  // ---- 2. 50k-row CSV validate
  const lines = ['pid_number,owner_name,mobile,address,zone_code,ward_number,latitude,longitude,route_code'];
  for (let i = 1; i <= 50_000; i++) {
    const w = ((i - 1) % 20) + 1;
    const zone = i % 100 === 0 ? 'NOZONE' : w <= 10 ? 'PZ1' : 'PZ2'; // 1% unknown zone
    const num = i % 2 ? `NEW${String(i).padStart(6, '0')}` : `PERF${String(i).padStart(6, '0')}`; // half already exist
    const coords = i % 50 === 0 ? ',' : `${(AREA.minLat + Math.random() * 0.2).toFixed(6)},${(AREA.minLng + Math.random() * 0.2).toFixed(6)}`;
    lines.push(`${num},Owner ${i},,Addr ${i},${zone},W${String(w).padStart(2, '0')},${coords},`);
  }
  const csv = Buffer.from(lines.join('\n'));
  t0 = performance.now();
  const val = await request(app).post('/api/pids/import?mode=validate').set(auth).attach('file', csv, 'perf.csv');
  const valMs = ms(t0);
  console.log(`\n== 2. Import validate, 50,000 rows (${(csv.length / 1024 / 1024).toFixed(1)} MB): HTTP ${valMs} ms, status ${val.status}`);
  console.log(`   summary: ${JSON.stringify(val.body.data?.summary)}`);

  // ---- 3. assignment create for a 2,000-PID route
  const ward = (await pool.query("SELECT id, zone_id FROM wards WHERE ward_number = 'W01'")).rows[0];
  const route = (await pool.query(
    `INSERT INTO routes (route_code, route_name, zone_id, ward_id) VALUES ('PERFR1', 'Perf route', $1, $2) RETURNING id`,
    [ward.zone_id, ward.id])).rows[0];
  await pool.query(
    `INSERT INTO route_pids (route_id, pid_id, sequence_no)
     SELECT $1, id, row_number() OVER (ORDER BY id) FROM pids WHERE ward_id = $2 ORDER BY id LIMIT 2000`, [route.id, ward.id]);
  const vehicles = (await pool.query(
    `INSERT INTO vehicles (vehicle_number, vehicle_type) SELECT 'PERFV' || g, 'Tipper' FROM generate_series(1, 4) g RETURNING id`)).rows;
  const date = addDays(todayInTz(), 1);
  const raTimes = [];
  for (const [i, v] of vehicles.entries()) {
    // Same route on 4 different vehicles -> 4 independent 2,000-PID snapshots.
    t0 = performance.now();
    const res = await request(app).post('/api/route-assignments').set(auth) // eslint-disable-line no-await-in-loop
      .send({ route_id: route.id, vehicle_id: v.id, operational_date: date });
    raTimes.push(ms(t0));
    if (i === 0) console.log(`\n== 3. POST /api/route-assignments (2,000 PIDs): status ${res.status}, assigned_pid_count ${res.body.data?.assigned_pid_count}`);
  }
  console.log(`   HTTP times: ${raTimes.join(', ')} ms (median ${median(raTimes)})`);
  const snapPlan = await explain(
    `SELECT p.id, p.latitude, p.longitude FROM route_pids rp JOIN pids p ON p.id = rp.pid_id WHERE rp.route_id = $1 AND p.status = 'ACTIVE'`,
    [route.id]);
  console.log('   snapshot source query plan:');
  console.log(snapPlan);

  console.log(`\n== Round-trip budget: map = 2 queries (auth + map), assignment create = 7 (auth, BEGIN, lock, checks, insert-CTE, COMMIT, reload).`);
  console.log(`   At ${median(rtt).toFixed(0)} ms/RTT that is ~${Math.round(2 * median(rtt))} ms and ~${Math.round(7 * median(rtt))} ms of pure network wait.`);
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
