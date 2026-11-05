// GUIDE #11 A4: partitioned gps_locations — pre-creation idempotent, DEFAULT alert, retention drops whole
// partitions while visit evidence survives, reprocess on an aged-out day -> 409, partition pruning.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { listPartitions, retainedFrom, runGpsLifecycle } from '../../src/services/gps/gpsLifecycleService.js';
import { buildHistoryQuery } from '../../src/services/gps/gpsReadService.js';
import { createUser, bearer } from '../helpers/fixtures.js';
import { makeAssignment, track, insertEvents, ist } from '../helpers/detection.js';

const silent = { info() {}, warn() {}, error() {} };
let app;
beforeAll(() => {
  app = createApp();
});

/** Relation names an EXPLAIN plan touches. */
async function scannedRelations(text, values) {
  const { rows: [r] } = await pool.query(`EXPLAIN (FORMAT JSON) ${text}`, values);
  const names = new Set();
  const walk = (n) => {
    if (n['Relation Name']) names.add(n['Relation Name']);
    (n.Plans || []).forEach(walk);
  };
  walk(r['QUERY PLAN'][0].Plan);
  return [...names];
}

describe('partitioned gps_locations', () => {
  it('migration created DEFAULT + monthly partitions (previous month .. +2); pre-creation is idempotent', async () => {
    const parts = await listPartitions();
    expect(parts.find((p) => p.is_default)?.name).toBe('gps_locations_default');
    const monthly = parts.filter((p) => !p.is_default);
    expect(monthly.length).toBeGreaterThanOrEqual(4);
    for (const p of monthly) expect(p.name).toMatch(/^gps_locations_p\d{4}_\d{2}$/);
    const first = await runGpsLifecycle({ logger: silent, retentionDays: 3650 });
    expect(first.status).toBe('done');
    const again = await runGpsLifecycle({ logger: silent, retentionDays: 3650 });
    expect(again.created).toEqual([]); // idempotent
    expect((await listPartitions()).length).toBe(parts.length + first.created.length);
    const { rows } = await pool.query("SELECT gps_ensure_partitions('2031-07-01', 1) AS n");
    expect(rows.map((r) => r.n)).toEqual(['gps_locations_p2031_07']);
    expect((await pool.query("SELECT gps_ensure_partitions('2031-07-01', 1) AS n")).rows).toEqual([]);
  });

  it('IST month bounds; a far-future row lands in DEFAULT and the lifecycle run alerts', async () => {
    const p = (await listPartitions()).find((x) => x.name === 'gps_locations_p2031_07');
    expect(new Date(p.range_from).toISOString()).toBe('2031-06-30T18:30:00.000Z'); // 2031-07-01 00:00 IST
    expect(new Date(p.range_to).toISOString()).toBe('2031-07-31T18:30:00.000Z');
    const a = await makeAssignment({ pids: [[28.5, 77.2]], date: '2099-05-01' });
    await track(a.vehicle.id, [{ p: [28.5, 77.2], t: ist('2099-05-01', '09:00:00') }]);
    const { rows: [where] } = await pool.query("SELECT tableoid::regclass::text AS part FROM gps_locations WHERE recorded_at > '2099-01-01'");
    expect(where.part).toMatch(/gps_locations_default$/);
    const r = await runGpsLifecycle({ logger: silent, retentionDays: 3650 });
    expect(r.default_rows).toBeGreaterThan(0);
    expect(r.alerts.join(' ')).toMatch(/rows in gps_locations_default/);
  });

  it('retention drops a whole old partition; visit evidence keeps its own GPS copy; reprocess of that day -> 409', async () => {
    await pool.query("SELECT gps_ensure_partitions('2020-01-01', 1)");
    const a = await makeAssignment({ pids: [[28.5, 77.2]], date: '2020-01-15' });
    const [gid] = await track(a.vehicle.id, [{ p: [28.5001, 77.2002], t: ist('2020-01-15', '09:00:00'), speed: 12.5 }]);
    expect((await pool.query("SELECT tableoid::regclass::text AS part FROM gps_locations WHERE id = $1", [gid])).rows[0].part).toMatch(/gps_locations_p2020_01$/);
    await insertEvents([{ raId: a.raId, pidId: a.pidIds[0], vehicleId: a.vehicle.id, gpsId: gid, dist: 21.6, status: 'PROXIMITY_POINT' }]);
    await pool.query("UPDATE pid_daily_status SET visit_status = 'GPS_VISIT_CANDIDATE' WHERE route_assignment_id = $1", [a.raId]);

    const r = await runGpsLifecycle({ logger: silent, retentionDays: 180 });
    expect(r.dropped).toContain('gps_locations_p2020_01');
    expect((await listPartitions()).some((p) => p.name === 'gps_locations_p2020_01')).toBe(false);
    expect((await pool.query('SELECT count(*)::int n FROM gps_locations WHERE id = $1', [gid])).rows[0].n).toBe(0);
    const ev = (await pool.query('SELECT gps_location_id, gps_recorded_at, gps_latitude, gps_longitude, gps_speed, distance_meters FROM pid_visit_events WHERE route_assignment_id = $1', [a.raId])).rows;
    expect(ev).toEqual([{ gps_location_id: gid, gps_recorded_at: ist('2020-01-15', '09:00:00'), gps_latitude: 28.5001, gps_longitude: 77.2002, gps_speed: 12.5, distance_meters: 21.6 }]);

    // The evidence API still shows it after the raw point is gone.
    const admin = await createUser('SUPER_ADMIN');
    const list = await request(app).get(`/api/pid-visits?date=2020-01-15&route_assignment_id=${a.raId}`).set(bearer(admin.token));
    expect(list.body.data).toHaveLength(1);

    expect(new Date(await retainedFrom()) > new Date('2020-02-01')).toBe(true);
    const rp = await request(app).post('/api/detection/reprocess').set(bearer(admin.token)).send({ route_assignment_id: a.raId });
    expect(rp.status).toBe(409);
    expect(rp.body.message).toMatch(/Raw GPS no longer retained/);
    // nothing was touched
    expect((await pool.query('SELECT count(*)::int n FROM pid_visit_events WHERE route_assignment_id = $1', [a.raId])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT visit_status FROM pid_daily_status WHERE route_assignment_id = $1', [a.raId])).rows[0].visit_status).toBe('GPS_VISIT_CANDIDATE');
  });

  it('time-bounded GPS queries prune to the partition(s) of their window', async () => {
    await pool.query("SELECT gps_ensure_partitions('2031-08-01', 2)");
    const h = buildHistoryQuery(1, new Date('2031-08-10T00:00:00+05:30'), new Date('2031-08-10T23:59:59+05:30'), 5000);
    const rel = await scannedRelations(h.text, h.values);
    expect(rel.filter((n) => n.startsWith('gps_locations'))).toEqual(['gps_locations_p2031_08']);
    const adj = await scannedRelations(
      "SELECT 1 FROM gps_locations g WHERE g.vehicle_id = 1 AND g.recorded_at > '2031-09-02T10:00:00Z' AND g.recorded_at < '2031-09-02T10:01:00Z'", []);
    expect(adj).toEqual(['gps_locations_p2031_09']);
  });
});
