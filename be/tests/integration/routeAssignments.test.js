import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { todayInTz, addDays } from '../../src/utils/time.js';
import {
  createUser, createAgency, createVehicle, createRouteWithPids, createPid, addRoutePids, bearer,
} from '../helpers/fixtures.js';

let app; let admin; let dept;
const today = todayInTz('Asia/Kolkata');
let dayCounter = 10;
const nextDay = () => addDays(today, dayCounter++);
const at = (date, hhmm) => `${date}T${hhmm}:00+05:30`;

const post = (body, token = admin.token) => request(app).post('/api/route-assignments').set(bearer(token)).send(body);

beforeAll(async () => {
  app = createApp();
  admin = await createUser('SUPER_ADMIN');
  dept = await createUser('DEPARTMENT_ADMIN');
});

async function addVisitEvent(raId, pidId, vehicleId) {
  const g = (await pool.query(
    `INSERT INTO gps_locations (vehicle_id, device_id, latitude, longitude, recorded_at) VALUES ($1, 'D', 28.4, 77.3, now()) RETURNING id`,
    [vehicleId])).rows[0];
  await pool.query(
    `INSERT INTO pid_visit_events (route_assignment_id, pid_id, vehicle_id, gps_location_id, distance_meters, detected_at, evidence_status)
     VALUES ($1, $2, $3, $4, 10, now(), 'PROXIMITY_POINT')`, [raId, pidId, vehicleId, g.id]);
}

describe('create', () => {
  it('snapshots PIDs, pre-creates statuses (GPS_DATA_UNAVAILABLE for missing coords) and snapshots agency', async () => {
    const agency = await createAgency();
    const { route, pids } = await createRouteWithPids(3, { agency_id: agency.id, withoutCoords: [2] });
    const vehicle = await createVehicle();
    const date = nextDay();
    const res = await post({ route_id: route.id, vehicle_id: vehicle.id, operational_date: date });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      operational_date: date, status: 'PLANNED', assigned_pid_count: 3, covered_pid_count: 0, agency_id: agency.id, route_code: route.route_code,
    });
    const id = res.body.data.id;

    const snap = (await pool.query('SELECT pid_id, pid_latitude FROM route_assignment_pids WHERE route_assignment_id = $1 ORDER BY pid_id', [id])).rows;
    expect(snap.map((s) => s.pid_id)).toEqual(pids.map((p) => p.id).sort((a, b) => a - b));
    const statuses = Object.fromEntries((await pool.query(
      'SELECT pid_id, visit_status, operational_date::text AS d, vehicle_id FROM pid_daily_status WHERE route_assignment_id = $1', [id])).rows
      .map((s) => [s.pid_id, s]));
    expect(statuses[pids[0].id]).toMatchObject({ visit_status: 'NOT_VISITED', d: date, vehicle_id: vehicle.id });
    expect(statuses[pids[2].id].visit_status).toBe('GPS_DATA_UNAVAILABLE');

    const detail = await request(app).get(`/api/route-assignments/${id}`).set(bearer(admin.token));
    expect(detail.body.data.pids).toHaveLength(3);
    expect(detail.body.data.pids_pagination.total).toBe(3);
    const unavailable = await request(app).get(`/api/route-assignments/${id}?visit_status=GPS_DATA_UNAVAILABLE`).set(bearer(admin.token));
    expect(unavailable.body.data.pids.map((p) => p.pid_id)).toEqual([pids[2].id]);
  });

  it("falls back to the vehicle's agency when the route has none; excludes inactive PIDs", async () => {
    const agency = await createAgency();
    const { route, pids } = await createRouteWithPids(2);
    await pool.query("UPDATE pids SET status = 'INACTIVE' WHERE id = $1", [pids[1].id]);
    const vehicle = await createVehicle({ agency_id: agency.id });
    const res = await post({ route_id: route.id, vehicle_id: vehicle.id, operational_date: nextDay() });
    expect(res.body.data).toMatchObject({ agency_id: agency.id, assigned_pid_count: 1 });
  });

  it('422 for a route with no PIDs (and nothing is left behind), inactive route or vehicle', async () => {
    const { route } = await createRouteWithPids(0);
    const vehicle = await createVehicle();
    const res = await post({ route_id: route.id, vehicle_id: vehicle.id, operational_date: nextDay() });
    expect(res.status).toBe(422);
    expect((await pool.query('SELECT count(*)::int AS n FROM route_assignments WHERE route_id = $1', [route.id])).rows[0].n).toBe(0);

    const { route: r2 } = await createRouteWithPids(1);
    const inactiveVehicle = await createVehicle();
    await pool.query("UPDATE vehicles SET status = 'MAINTENANCE' WHERE id = $1", [inactiveVehicle.id]);
    expect((await post({ route_id: r2.id, vehicle_id: inactiveVehicle.id, operational_date: nextDay() })).status).toBe(422);
    await pool.query("UPDATE routes SET status = 'INACTIVE' WHERE id = $1", [r2.id]);
    expect((await post({ route_id: r2.id, vehicle_id: vehicle.id, operational_date: nextDay() })).status).toBe(422);
  });

  it('rejects duplicates (409) but allows re-creating after cancel', async () => {
    const { route } = await createRouteWithPids(1);
    const vehicle = await createVehicle();
    const date = nextDay();
    const first = await post({ route_id: route.id, vehicle_id: vehicle.id, operational_date: date });
    expect((await post({ route_id: route.id, vehicle_id: vehicle.id, operational_date: date })).status).toBe(409);
    await request(app).patch(`/api/route-assignments/${first.body.data.id}/cancel`).set(bearer(admin.token));
    expect((await post({ route_id: route.id, vehicle_id: vehicle.id, operational_date: date })).status).toBe(201);
  });

  it('past dates: 422 without allow_past, 403 for non-super-admin, allowed for SUPER_ADMIN', async () => {
    const { route } = await createRouteWithPids(1);
    const vehicle = await createVehicle();
    const past = addDays(today, -3);
    expect((await post({ route_id: route.id, vehicle_id: vehicle.id, operational_date: past })).status).toBe(422);
    expect((await post({ route_id: route.id, vehicle_id: vehicle.id, operational_date: past, allow_past: true }, dept.token)).status).toBe(403);
    expect((await post({ route_id: route.id, vehicle_id: vehicle.id, operational_date: past, allow_past: true })).status).toBe(201);
    // Today itself is allowed.
    const { route: r2 } = await createRouteWithPids(1);
    expect((await post({ route_id: r2.id, vehicle_id: vehicle.id, operational_date: today })).status).toBe(201);
  });
});

describe('shift / overlap rules', () => {
  it('at most one NULL-window assignment per vehicle and date; windows may coexist with it', async () => {
    const { route: a } = await createRouteWithPids(1);
    const { route: b } = await createRouteWithPids(1);
    const { route: c } = await createRouteWithPids(1);
    const vehicle = await createVehicle();
    const date = nextDay();
    expect((await post({ route_id: a.id, vehicle_id: vehicle.id, operational_date: date })).status).toBe(201);
    const second = await post({ route_id: b.id, vehicle_id: vehicle.id, operational_date: date });
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/all-day/);
    expect((await post({ route_id: c.id, vehicle_id: vehicle.id, operational_date: date, shift_start: at(date, '06:00'), shift_end: at(date, '10:00') })).status).toBe(201);
  });

  it('rejects overlapping windows (409) and accepts adjacent ones', async () => {
    const routes = [];
    for (let i = 0; i < 3; i++) routes.push((await createRouteWithPids(1)).route); // eslint-disable-line no-await-in-loop
    const vehicle = await createVehicle();
    const date = nextDay();
    expect((await post({ route_id: routes[0].id, vehicle_id: vehicle.id, operational_date: date, shift_start: at(date, '06:00'), shift_end: at(date, '10:00') })).status).toBe(201);
    expect((await post({ route_id: routes[1].id, vehicle_id: vehicle.id, operational_date: date, shift_start: at(date, '09:00'), shift_end: at(date, '12:00') })).status).toBe(409);
    expect((await post({ route_id: routes[2].id, vehicle_id: vehicle.id, operational_date: date, shift_start: at(date, '10:00'), shift_end: at(date, '14:00') })).status).toBe(201);
  });

  it('supports midnight-crossing shifts and checks overlap across dates; enforces the day window', async () => {
    const { route: night } = await createRouteWithPids(1);
    const { route: morning } = await createRouteWithPids(1);
    const { route: late } = await createRouteWithPids(1);
    const vehicle = await createVehicle();
    const d = nextDay();
    const d1 = addDays(d, 1);
    expect((await post({ route_id: night.id, vehicle_id: vehicle.id, operational_date: d, shift_start: at(d, '20:00'), shift_end: at(d1, '04:00') })).status).toBe(201);
    const clash = await post({ route_id: morning.id, vehicle_id: vehicle.id, operational_date: d1, shift_start: at(d1, '02:00'), shift_end: at(d1, '06:00') });
    expect(clash.status).toBe(409);
    expect((await post({ route_id: morning.id, vehicle_id: vehicle.id, operational_date: d1, shift_start: at(d1, '05:00'), shift_end: at(d1, '09:00') })).status).toBe(201);
    // Beyond next-day 12:00 IST, or starting before the day's 00:00 -> 422
    expect((await post({ route_id: late.id, vehicle_id: vehicle.id, operational_date: d, shift_start: at(d1, '11:00'), shift_end: at(d1, '13:00') })).status).toBe(422);
    expect((await post({ route_id: late.id, vehicle_id: vehicle.id, operational_date: d, shift_start: at(addDays(d, -1), '23:00'), shift_end: at(d, '02:00') })).status).toBe(422);
    // Validation: end before start, half window, no offset
    expect((await post({ route_id: late.id, vehicle_id: vehicle.id, operational_date: d, shift_start: at(d, '10:00'), shift_end: at(d, '09:00') })).status).toBe(400);
    expect((await post({ route_id: late.id, vehicle_id: vehicle.id, operational_date: d, shift_start: at(d, '10:00') })).status).toBe(400);
    expect((await post({ route_id: late.id, vehicle_id: vehicle.id, operational_date: d, shift_start: `${d}T10:00:00`, shift_end: `${d}T11:00:00` })).status).toBe(400);
  });

  it('serialises concurrent creates for the same vehicle/date: exactly one NULL-window wins', async () => {
    const { route: a } = await createRouteWithPids(1);
    const { route: b } = await createRouteWithPids(1);
    const vehicle = await createVehicle();
    const date = nextDay();
    const [r1, r2] = await Promise.all([
      post({ route_id: a.id, vehicle_id: vehicle.id, operational_date: date }),
      post({ route_id: b.id, vehicle_id: vehicle.id, operational_date: date }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const n = (await pool.query("SELECT count(*)::int AS n FROM route_assignments WHERE vehicle_id = $1 AND status <> 'CANCELLED'", [vehicle.id])).rows[0].n;
    expect(n).toBe(1);
  });
});

describe('snapshot immutability, cancel, resnapshot', () => {
  it('editing the route master after assignment does not change the snapshot', async () => {
    const { zone, ward, route, pids } = await createRouteWithPids(2);
    const vehicle = await createVehicle();
    const res = await post({ route_id: route.id, vehicle_id: vehicle.id, operational_date: nextDay() });
    const id = res.body.data.id;
    const before = (await pool.query('SELECT pid_id, pid_latitude, pid_longitude FROM route_assignment_pids WHERE route_assignment_id = $1 ORDER BY pid_id', [id])).rows;

    const newPid = await createPid({ zone_id: zone.id, ward_id: ward.id, latitude: 26.9, longitude: 75.9 });
    await request(app).post(`/api/routes/${route.id}/assign-pids`).set(bearer(admin.token)).send({ pid_ids: [newPid.id], mode: 'replace' });
    await request(app).patch(`/api/pids/${pids[0].id}/coordinates`).set(bearer(admin.token)).send({ latitude: 26.95, longitude: 75.95 });
    await request(app).put(`/api/routes/${route.id}`).set(bearer(admin.token)).send({ route_name: 'Renamed' });

    const after = (await pool.query('SELECT pid_id, pid_latitude, pid_longitude FROM route_assignment_pids WHERE route_assignment_id = $1 ORDER BY pid_id', [id])).rows;
    expect(after).toEqual(before);
  });

  it('resnapshot rebuilds from the current route while PLANNED with no events; 409 afterwards', async () => {
    const { zone, ward, route, pids } = await createRouteWithPids(2);
    const vehicle = await createVehicle();
    const id = (await post({ route_id: route.id, vehicle_id: vehicle.id, operational_date: nextDay() })).body.data.id;
    const extra = await createPid({ zone_id: zone.id, ward_id: ward.id });
    await addRoutePids(route.id, [extra.id]);

    const re = await request(app).post(`/api/route-assignments/${id}/resnapshot`).set(bearer(admin.token));
    expect(re.status).toBe(200);
    expect(re.body.data.assigned_pid_count).toBe(3);
    const st = (await pool.query('SELECT visit_status FROM pid_daily_status WHERE route_assignment_id = $1 AND pid_id = $2', [id, extra.id])).rows[0];
    expect(st.visit_status).toBe('GPS_DATA_UNAVAILABLE');

    await addVisitEvent(id, pids[0].id, vehicle.id);
    const blocked = await request(app).post(`/api/route-assignments/${id}/resnapshot`).set(bearer(admin.token));
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/GPS activity/);
  });

  it('cancel: PLANNED ok; ACTIVE without events ok; ACTIVE with events / COMPLETED / CANCELLED -> 409', async () => {
    const mk = async () => {
      const { route, pids } = await createRouteWithPids(1);
      const vehicle = await createVehicle();
      const id = (await post({ route_id: route.id, vehicle_id: vehicle.id, operational_date: nextDay() })).body.data.id;
      return { id, pid: pids[0], vehicle };
    };
    const cancel = (id) => request(app).patch(`/api/route-assignments/${id}/cancel`).set(bearer(admin.token));

    const planned = await mk();
    const c1 = await cancel(planned.id);
    expect(c1.status).toBe(200);
    expect(c1.body.data.status).toBe('CANCELLED');
    expect((await cancel(planned.id)).status).toBe(409);

    const activeNoEvents = await mk();
    await pool.query("UPDATE route_assignments SET status = 'ACTIVE' WHERE id = $1", [activeNoEvents.id]);
    expect((await cancel(activeNoEvents.id)).status).toBe(200);

    const activeEvents = await mk();
    await pool.query("UPDATE route_assignments SET status = 'ACTIVE' WHERE id = $1", [activeEvents.id]);
    await addVisitEvent(activeEvents.id, activeEvents.pid.id, activeEvents.vehicle.id);
    expect((await cancel(activeEvents.id)).status).toBe(409);

    const completed = await mk();
    await pool.query("UPDATE route_assignments SET status = 'COMPLETED' WHERE id = $1", [completed.id]);
    expect((await cancel(completed.id)).status).toBe(409);
  });
});

describe('bulk', () => {
  it('assignments[]: per-item results with savepoints (partial failure keeps the rest)', async () => {
    const { route: a } = await createRouteWithPids(1);
    const { route: empty } = await createRouteWithPids(0);
    const vehicle1 = await createVehicle();
    const vehicle2 = await createVehicle();
    const date = nextDay();
    const res = await request(app).post('/api/route-assignments/bulk').set(bearer(admin.token)).send({
      assignments: [
        { route_id: a.id, vehicle_id: vehicle1.id, operational_date: date },
        { route_id: empty.id, vehicle_id: vehicle2.id, operational_date: date },
        { route_id: a.id, vehicle_id: vehicle1.id, operational_date: date },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({ total: 3, created: 1, skipped_duplicate: 1, error: 1 });
    expect(res.body.data.results.map((r) => r.result)).toEqual(['created', 'error', 'skipped_duplicate']);
    expect(res.body.data.results[1].message).toMatch(/no active PIDs/);
  });

  it('copy_from_date copies non-cancelled assignments with shifted windows; reports duplicates and errors', async () => {
    const { route: r1, zone } = await createRouteWithPids(1);
    const { route: r2 } = await createRouteWithPids(1);
    const { route: r3 } = await createRouteWithPids(1);
    const v1 = await createVehicle(); const v2 = await createVehicle(); const v3 = await createVehicle();
    const from = nextDay();
    const to = nextDay();
    await post({ route_id: r1.id, vehicle_id: v1.id, operational_date: from, shift_start: at(from, '06:00'), shift_end: at(from, '10:00') });
    await post({ route_id: r2.id, vehicle_id: v2.id, operational_date: from });
    const cancelled = await post({ route_id: r3.id, vehicle_id: v3.id, operational_date: from });
    await request(app).patch(`/api/route-assignments/${cancelled.body.data.id}/cancel`).set(bearer(admin.token));
    await post({ route_id: r2.id, vehicle_id: v2.id, operational_date: to }); // pre-existing -> duplicate
    const zoneFilter = await request(app).post('/api/route-assignments/bulk').set(bearer(admin.token))
      .send({ copy_from_date: from, to_date: to, zone_id: zone.id });
    expect(zoneFilter.body.data.summary).toMatchObject({ total: 1, created: 1 });

    const all = await request(app).post('/api/route-assignments/bulk').set(bearer(admin.token)).send({ copy_from_date: from, to_date: to });
    const results = all.body.data.results.filter((r) => [r1.id, r2.id, r3.id].includes(r.route_id));
    expect(results.map((r) => [r.route_id, r.result])).toEqual([[r1.id, 'skipped_duplicate'], [r2.id, 'skipped_duplicate']]);

    const copied = (await pool.query(
      "SELECT shift_start FROM route_assignments WHERE route_id = $1 AND operational_date = $2 AND status <> 'CANCELLED'", [r1.id, to])).rows[0];
    expect(copied.shift_start.toISOString()).toBe(new Date(at(to, '06:00')).toISOString());
  });
});

describe('coverage breakdown', () => {
  it('list and detail return covered (CONFIRMED only), candidate and unavailable counts', async () => {
    const { route, pids } = await createRouteWithPids(5, { withoutCoords: [4] });
    const vehicle = await createVehicle();
    const d = nextDay();
    const id = (await post({ route_id: route.id, vehicle_id: vehicle.id, operational_date: d })).body.data.id;
    await pool.query(
      `UPDATE pid_daily_status SET visit_status = CASE pid_id WHEN $2 THEN 'GPS_VISIT_CONFIRMED' WHEN $3 THEN 'GPS_VISIT_CONFIRMED'
         WHEN $4 THEN 'GPS_VISIT_CANDIDATE' ELSE visit_status END WHERE route_assignment_id = $1`,
      [id, pids[0].id, pids[1].id, pids[2].id]);
    const expected = { assigned_pid_count: 5, covered_pid_count: 2, candidate_pid_count: 1, unavailable_pid_count: 1 };

    const list = await request(app).get(`/api/route-assignments?operational_date=${d}&vehicle_id=${vehicle.id}`).set(bearer(admin.token));
    expect(list.body.data[0]).toMatchObject(expected);
    const detail = await request(app).get(`/api/route-assignments/${id}`).set(bearer(admin.token));
    expect(detail.body.data).toMatchObject(expected);
  });
});

describe('list + scope', () => {
  it('defaults to today, filters by date range (max 31 days) and applies agency scope', async () => {
    const agency = await createAgency();
    const { route } = await createRouteWithPids(1, { agency_id: agency.id });
    const { route: other } = await createRouteWithPids(1);
    const v = await createVehicle();
    const v2 = await createVehicle();
    const d = nextDay();
    const mine = (await post({ route_id: route.id, vehicle_id: v.id, operational_date: d })).body.data.id;
    const theirs = (await post({ route_id: other.id, vehicle_id: v2.id, operational_date: d })).body.data.id;

    const todayList = await request(app).get('/api/route-assignments').set(bearer(admin.token));
    expect(todayList.status).toBe(200);
    expect(todayList.body.data.every((r) => r.operational_date === today)).toBe(true);

    const u = await createUser('AGENCY_USER', { agency_id: agency.id });
    const scoped = await request(app).get(`/api/route-assignments?operational_date=${d}`).set(bearer(u.token));
    expect(scoped.body.data.map((r) => r.id)).toEqual([mine]);
    expect(scoped.body.data[0]).toMatchObject({ route_code: route.route_code, vehicle_number: v.vehicle_number, assigned_pid_count: 1, covered_pid_count: 0 });
    expect((await request(app).get(`/api/route-assignments/${theirs}`).set(bearer(u.token))).status).toBe(404);
    expect((await post({ route_id: route.id, vehicle_id: v2.id, operational_date: nextDay() }, u.token)).status).toBe(403);

    const range = await request(app).get(`/api/route-assignments?date_from=${today}&date_to=${addDays(today, 31)}`).set(bearer(admin.token));
    expect(range.status).toBe(400);
    const okRange = await request(app).get(`/api/route-assignments?date_from=${d}&date_to=${d}&vehicle_id=${v.id}`).set(bearer(admin.token));
    expect(okRange.body.data.map((r) => r.id)).toEqual([mine]);

    const za = await createUser('ZONE_ADMIN', { zone_id: route.zone_id });
    expect((await request(app).get(`/api/route-assignments?operational_date=${d}`).set(bearer(za.token))).body.data.map((r) => r.id)).toEqual([mine]);
  });
});
