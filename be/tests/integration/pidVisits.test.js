import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { todayInTz, addDays } from '../../src/utils/time.js';
import { createUser, createAgency, bearer } from '../helpers/fixtures.js';
import { ORIGIN, at, ist, makeAssignment, track, detect } from '../helpers/detection.js';

let app; let admin; let date; let a; let b; let agencyA;

beforeAll(async () => {
  app = createApp();
  admin = await createUser('SUPER_ADMIN');
  date = addDays(todayInTz('Asia/Kolkata'), 90);
  agencyA = await createAgency();
  // a: 4 PIDs -> 1 confirmed, 1 candidate (+ambiguous pair), 1 not visited, 1 unavailable
  a = await makeAssignment({ pids: [ORIGIN, at(200), at(208), at(2000), null], date });
  await pool.query('UPDATE route_assignments SET agency_id = $2 WHERE id = $1', [a.raId, agencyA.id]);
  await track(a.vehicle.id, [
    { p: at(3), t: ist(date, '09:00:00') }, { p: at(-3), t: ist(date, '09:00:10') }, // confirm ORIGIN
    { p: at(204), t: ist(date, '09:05:00') }, // candidate for both 200 & 208 (ambiguous)
  ]);
  // b: another agency, 2 PIDs, nothing visited
  b = await makeAssignment({ pids: [at(0, 5000), at(0, 5100)], date });
  await detect();
});

describe('pid-visits APIs', () => {
  it('GET /pid-visits filters by date, assignment, evidence and ambiguous', async () => {
    const all = await request(app).get(`/api/pid-visits?date=${date}&route_assignment_id=${a.raId}`).set(bearer(admin.token));
    expect(all.status).toBe(200);
    expect(all.body.pagination.total).toBe(4); // 2 for ORIGIN + 2 ambiguous
    const amb = await request(app).get(`/api/pid-visits?date=${date}&route_assignment_id=${a.raId}&ambiguous=true`).set(bearer(admin.token));
    expect(amb.body.data).toHaveLength(2);
    expect(amb.body.data.every((e) => e.pids_in_radius === 2)).toBe(true);
    expect((await request(app).get('/api/pid-visits').set(bearer(admin.token))).status).toBe(400); // date required
  });

  it('daily-summary: coverage = confirmed / assigned × 100 over PIDs assigned that day', async () => {
    const res = await request(app).get(`/api/pid-visits/daily-summary?date=${date}&group_by=route`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    const ga = res.body.data.groups.find((g) => g.group_id === a.routeId);
    expect(ga).toMatchObject({ assigned: 5, confirmed: 1, candidate: 2, not_visited: 1, unavailable: 1, coverage_pct: 20 });
    const gb = res.body.data.groups.find((g) => g.group_id === b.routeId);
    expect(gb).toMatchObject({ assigned: 2, confirmed: 0, coverage_pct: 0 });
    expect(res.body.data.totals).toMatchObject({ assigned: 7, confirmed: 1, coverage_pct: 14.3 });
  });

  it('missed: every non-confirmed status with a reason; filter by status', async () => {
    const res = await request(app).get(`/api/pid-visits/missed?date=${date}&limit=100`).set(bearer(admin.token));
    const mine = res.body.data.filter((m) => m.route_assignment_id === a.raId);
    expect(mine.map((m) => m.visit_status).sort()).toEqual(['GPS_DATA_UNAVAILABLE', 'GPS_VISIT_CANDIDATE', 'GPS_VISIT_CANDIDATE', 'NOT_VISITED']);
    expect(mine.every((m) => m.reason)).toBe(true);
    const cand = await request(app).get(`/api/pid-visits/missed?date=${date}&visit_status=GPS_VISIT_CANDIDATE&limit=100`).set(bearer(admin.token));
    expect(cand.body.data.every((m) => m.visit_status === 'GPS_VISIT_CANDIDATE')).toBe(true);
  });

  it('PID history returns daily statuses with their events', async () => {
    const res = await request(app).get(`/api/pid-visits/${a.pidIds[0]}/history?from=${date}&to=${date}`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.days).toHaveLength(1);
    expect(res.body.data.days[0]).toMatchObject({ visit_status: 'GPS_VISIT_CONFIRMED', detection_count: 2 });
    expect(res.body.data.days[0].events).toHaveLength(2);
    expect((await request(app).get(`/api/pid-visits/${a.pidIds[0]}/history?from=${date}&to=${addDays(date, 40)}`).set(bearer(admin.token))).status).toBe(400);
  });

  it('agency users only see their own assignments', async () => {
    const u = await createUser('AGENCY_USER', { agency_id: agencyA.id });
    const sum = await request(app).get(`/api/pid-visits/daily-summary?date=${date}&group_by=route`).set(bearer(u.token));
    expect(sum.body.data.groups.map((g) => g.group_id)).toEqual([a.routeId]);
    const missed = await request(app).get(`/api/pid-visits/missed?date=${date}&limit=100`).set(bearer(u.token));
    expect(missed.body.data.every((m) => m.route_assignment_id === a.raId)).toBe(true);
    const ev = await request(app).get(`/api/pid-visits?date=${date}&route_assignment_id=${b.raId}`).set(bearer(u.token));
    expect(ev.body.data).toEqual([]);
  });
});

describe('settings admin + reprocess API', () => {
  it('validates per key, audits old -> new, and is SUPER_ADMIN only', async () => {
    const dept = await createUser('DEPARTMENT_ADMIN');
    expect((await request(app).put('/api/settings/detection.radius_m').set(bearer(dept.token)).send({ value: 40 })).status).toBe(403);
    expect((await request(app).get('/api/settings').set(bearer(dept.token))).status).toBe(403);
    expect((await request(app).get('/api/settings/public').set(bearer(dept.token))).status).toBe(200); // public stays open

    for (const [key, value] of [['detection.radius_m', 2], ['detection.radius_m', 500], ['detection.consecutive_points', 0],
      ['detection.confirmation_mode', 'magic'], ['detection.radius_m', '30'], ['app.timezone', 'Mars/Base']]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await request(app).put(`/api/settings/${key}`).set(bearer(admin.token)).send({ value })).status).toBe(400);
    }
    expect((await request(app).put('/api/settings/not.a.key').set(bearer(admin.token)).send({ value: 1 })).status).toBe(404);

    const ok = await request(app).put('/api/settings/detection.radius_m').set(bearer(admin.token)).send({ value: 45 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.setting_value).toBe(45);
    const audit = (await pool.query("SELECT details FROM activity_logs WHERE module = 'settings' AND reference_id = 'detection.radius_m' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(audit.details).toEqual({ old: 30, new: 45 });
    await request(app).put('/api/settings/detection.radius_m').set(bearer(admin.token)).send({ value: 30 });

    const list = await request(app).get('/api/settings').set(bearer(admin.token));
    expect(list.body.data.find((r) => r.setting_key === 'detection.radius_m').editable).toBe(true);
  });

  it('POST /detection/reprocess: SUPER_ADMIN only; by date returns per-assignment results', async () => {
    const dept = await createUser('DEPARTMENT_ADMIN');
    expect((await request(app).post('/api/detection/reprocess').set(bearer(dept.token)).send({ route_assignment_id: a.raId })).status).toBe(403);
    const res = await request(app).post('/api/detection/reprocess').set(bearer(admin.token)).send({ operational_date: date });
    expect(res.status).toBe(200);
    expect(res.body.data.assignments).toBeGreaterThanOrEqual(2);
    await detect();
    const s = (await pool.query('SELECT visit_status FROM pid_daily_status WHERE route_assignment_id = $1 AND pid_id = $2', [a.raId, a.pidIds[0]])).rows[0];
    expect(s.visit_status).toBe('GPS_VISIT_CONFIRMED'); // same settings -> same result after reprocess
    expect((await request(app).post('/api/detection/reprocess').set(bearer(admin.token)).send({ route_assignment_id: 99999999 })).status).toBe(404);
  });
});
