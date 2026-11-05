// Dashboard: every card and grouping from a known fixture (GUIDE #8 C/F). All numbers from real tables.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { createUser, createAgency, createZone, createWard, createVehicle, createPid, bearer } from '../helpers/fixtures.js';
import { makeAssignment, track, ist } from '../helpers/detection.js';

const D = '2031-03-10';
let app; let admin; let zone; let w1; let w2; let a1; let a2; let v1; let v2; let v3; let asg1; let asg2; let gpsIds;

const setStatus = (raId, pidId, st) => pool.query('UPDATE pid_daily_status SET visit_status = $3 WHERE route_assignment_id = $1 AND pid_id = $2', [raId, pidId, st]);

beforeAll(async () => {
  app = createApp();
  admin = await createUser('SUPER_ADMIN');
  zone = await createZone();
  w1 = await createWard(zone.id);
  w2 = await createWard(zone.id);
  a1 = await createAgency();
  a2 = await createAgency();
  v1 = await createVehicle({ agency_id: a1.id, zone_id: zone.id, ward_id: w1.id });
  v2 = await createVehicle({ agency_id: a2.id, zone_id: zone.id, ward_id: w2.id });
  v3 = await createVehicle({ agency_id: a1.id, zone_id: zone.id, ward_id: w1.id });
  await pool.query("UPDATE vehicles SET status = 'MAINTENANCE' WHERE id = $1", [v3.id]);

  asg1 = await makeAssignment({ pids: [[28.5, 77.2], [28.501, 77.2], [28.502, 77.2], [28.503, 77.2]], date: D, vehicle: v1, routeWard: { zone, ward: w1 } });
  asg2 = await makeAssignment({ pids: [[28.6, 77.2], [28.601, 77.2], null], date: D, vehicle: v2, routeWard: { zone, ward: w2 } });
  await pool.query('UPDATE route_assignments SET agency_id = $2 WHERE id = $1', [asg1.raId, a1.id]);
  await pool.query('UPDATE route_assignments SET agency_id = $2 WHERE id = $1', [asg2.raId, a2.id]);
  await setStatus(asg1.raId, asg1.pidIds[0], 'GPS_VISIT_CONFIRMED');
  await setStatus(asg1.raId, asg1.pidIds[1], 'GPS_VISIT_CONFIRMED');
  await setStatus(asg1.raId, asg1.pidIds[2], 'GPS_VISIT_CANDIDATE');
  // asg2: pid 3 has NULL coords -> already GPS_DATA_UNAVAILABLE; others NOT_VISITED
  await createPid({ zone_id: zone.id, ward_id: w2.id }); // registered, unassigned
  await createPid({ zone_id: zone.id, ward_id: w2.id, status: 'INACTIVE' }); // not counted

  // GPS for v1 on D: 3 points at 09:xx IST, 1 at 14:xx; none for v2. Mark processed (no detection here).
  gpsIds = await track(v1.id, [
    { p: [28.5, 77.2], t: ist(D, '09:05:00') }, { p: [28.5, 77.2001], t: ist(D, '09:06:00') },
    { p: [28.5, 77.2002], t: ist(D, '09:40:00') }, { p: [28.5, 77.2003], t: ist(D, '14:10:00') }]);
  await pool.query('UPDATE gps_locations SET processed_at = now() WHERE id = ANY($1)', [gpsIds]);
  await pool.query(
    `INSERT INTO pid_visit_events (route_assignment_id, pid_id, vehicle_id, gps_location_id, distance_meters, detected_at, evidence_status)
     VALUES ($1, $2, $3, $4, 5, $5, 'PROXIMITY_POINT'), ($1, $6, $3, $7, 6, $8, 'TRACK_SEGMENT'), ($1, $2, $3, $9, 7, $10, 'REJECTED_SPEED')`,
    [asg1.raId, asg1.pidIds[0], v1.id, gpsIds[0], ist(D, '09:05:00'), asg1.pidIds[2], gpsIds[1], ist(D, '09:06:00'), gpsIds[3], ist(D, '14:10:00')]);
});

const get = (path, token = admin.token) => request(app).get(path).set(bearer(token));

describe('GET /api/dashboard/summary', () => {
  it('returns every card exactly (zone filter isolates the fixture)', async () => {
    const res = await get(`/api/dashboard/summary?date=${D}&zone_id=${zone.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      date: D,
      total_vehicles: 3, active_vehicles: 1, offline_vehicles: 1, online_now: 0,
      total_registered_pids: 8, assigned_pids: 7,
      gps_confirmed_pids: 2, gps_candidate_pids: 1, gps_detected_pids: 3, gps_unavailable_pids: 1, remaining_pids: 5,
      gps_confirmed_coverage_pct: 28.6, gps_visit_detected_pct: 42.9,
    });
    expect(res.body.data.disclaimer).toMatch(/does not prove that garbage was collected/);
    expect(JSON.stringify(res.body.data)).not.toMatch(/collected_pids|collection_done/);
  });

  it('a ward supervisor’s summary covers only their ward', async () => {
    const ws = await createUser('WARD_SUPERVISOR', { zone_id: zone.id, ward_id: w1.id });
    const res = await get(`/api/dashboard/summary?date=${D}`, ws.token);
    expect(res.body.data).toMatchObject({
      total_vehicles: 2, active_vehicles: 1, offline_vehicles: 0, total_registered_pids: 4,
      assigned_pids: 4, gps_confirmed_pids: 2, gps_detected_pids: 3, gps_confirmed_coverage_pct: 50, gps_visit_detected_pct: 75,
    });
  });

  it('requires dashboard:read and validates the date', async () => {
    expect((await request(app).get('/api/dashboard/summary')).status).toBe(401);
    expect((await get('/api/dashboard/summary?date=10-03-2031')).status).toBe(400);
  });
});

describe('grouped dashboards', () => {
  it('ward-coverage and zone-coverage', async () => {
    const wards = (await get(`/api/dashboard/ward-coverage?date=${D}&zone_id=${zone.id}`)).body.data.groups;
    const byId = Object.fromEntries(wards.map((g) => [g.group_id, g]));
    expect(byId[w1.id]).toMatchObject({ assigned: 4, confirmed: 2, candidate: 1, unavailable: 0, remaining: 2, confirmed_pct: 50, detected_pct: 75 });
    expect(byId[w2.id]).toMatchObject({ assigned: 3, confirmed: 0, candidate: 0, unavailable: 1, remaining: 3, confirmed_pct: 0, detected_pct: 0 });
    const zones = (await get(`/api/dashboard/zone-coverage?date=${D}&zone_id=${zone.id}`)).body.data.groups;
    expect(zones).toEqual([expect.objectContaining({ group_id: zone.id, assigned: 7, confirmed: 2, candidate: 1, remaining: 5, confirmed_pct: 28.6, detected_pct: 42.9 })]);
  });

  it('agency-performance and vehicle-performance (with first/last GPS activity)', async () => {
    const ag = Object.fromEntries((await get(`/api/dashboard/agency-performance?date=${D}&zone_id=${zone.id}`)).body.data.groups.map((g) => [g.group_id, g]));
    expect(ag[a1.id]).toMatchObject({ assigned: 4, confirmed: 2, detected_pct: 75 });
    expect(ag[a2.id]).toMatchObject({ assigned: 3, confirmed: 0, confirmed_pct: 0 });
    const veh = Object.fromEntries((await get(`/api/dashboard/vehicle-performance?date=${D}&zone_id=${zone.id}`)).body.data.groups.map((g) => [g.group_id, g]));
    expect(veh[v1.id]).toMatchObject({ group_name: v1.vehicle_number, assigned: 4, confirmed: 2, remaining: 2 });
    expect(new Date(veh[v1.id].first_gps_activity).toISOString()).toBe(ist(D, '09:05:00').toISOString());
    expect(new Date(veh[v1.id].last_gps_activity).toISOString()).toBe(ist(D, '14:10:00').toISOString());
    expect(veh[v2.id]).toMatchObject({ first_gps_activity: null, last_gps_activity: null });
  });

  it('daily-trend fills empty days and enforces the 31-day limit', async () => {
    const res = await get(`/api/dashboard/daily-trend?from=2031-03-09&to=${D}&zone_id=${zone.id}`);
    expect(res.body.data.days).toEqual([
      { date: '2031-03-09', assigned: 0, confirmed: 0, detected: 0, confirmed_pct: null, detected_pct: null },
      { date: D, assigned: 7, confirmed: 2, detected: 3, confirmed_pct: 28.6, detected_pct: 42.9 },
    ]);
    expect((await get('/api/dashboard/daily-trend?from=2031-01-01&to=2031-03-10')).status).toBe(400);
  });

  it('hourly-activity: GPS points and (non-rejected) visit events per IST hour', async () => {
    const hours = (await get(`/api/dashboard/hourly-activity?date=${D}&zone_id=${zone.id}`)).body.data.hours;
    expect(hours).toHaveLength(24);
    expect(hours[9]).toEqual({ hour: 9, gps_points: 3, visit_events: 2 });
    expect(hours[14]).toEqual({ hour: 14, gps_points: 1, visit_events: 0 }); // the 14:10 event is REJECTED_SPEED
    expect(hours.filter((h) => ![9, 14].includes(h.hour)).every((h) => h.gps_points === 0 && h.visit_events === 0)).toBe(true);
  });

  it('agency users only see their own agency in every grouping', async () => {
    const u = await createUser('AGENCY_USER', { agency_id: a2.id });
    const ag = (await get(`/api/dashboard/agency-performance?date=${D}`, u.token)).body.data.groups;
    expect(ag.map((g) => g.group_id)).toEqual([a2.id]);
    const s = (await get(`/api/dashboard/summary?date=${D}`, u.token)).body.data;
    expect(s).toMatchObject({ assigned_pids: 3, gps_confirmed_pids: 0, total_vehicles: 1 });
  });
});
