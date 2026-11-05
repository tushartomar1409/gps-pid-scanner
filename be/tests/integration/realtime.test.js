// Socket.IO real-time (GUIDE #8 F): handshake auth, scope rooms, throttle, pid:status, periodic re-check.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { io as ioClient } from 'socket.io-client';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { attachRealtime } from '../../src/realtime/socketServer.js';
import { gpsEvents } from '../../src/services/gps/gpsEvents.js';
import { signToken } from '../../src/services/tokenService.js';
import { createUser, createAgency, createVehicle, createZoneWard, bearer } from '../helpers/fixtures.js';
import { makeAssignment } from '../helpers/detection.js';

let server; let rt; let url; let agencyA; let agencyB; let vA; let vB; let superU; let auA; let auB;
const clients = [];

function connect(token, extra = {}) {
  const c = ioClient(url, { path: '/socket.io', auth: token === undefined ? {} : { token }, transports: ['websocket'], reconnection: false, ...extra });
  clients.push(c);
  return c;
}
const ready = (c) => new Promise((res, rej) => { c.once('ready', res); c.once('connect_error', rej); });
const connectError = (c) => new Promise((res) => c.once('connect_error', (e) => res(e.message)));
const next = (c, ev, ms = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
  c.once(ev, (p) => { clearTimeout(t); res(p); });
});
const collect = (c, ev) => { const got = []; c.on(ev, (p) => got.push(p)); return got; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setLatest(vehicleId, lat, at = new Date()) {
  const g = (await pool.query(
    `INSERT INTO gps_locations (vehicle_id, device_id, latitude, longitude, speed, heading, recorded_at, provider)
     VALUES ($1, 'RT', $2, 77.3, 12, 90, $3, 'test') RETURNING id`, [vehicleId, lat, at])).rows[0];
  await pool.query(
    `INSERT INTO vehicle_latest_locations (vehicle_id, gps_location_id, latitude, longitude, speed, recorded_at, provider)
     VALUES ($1, $2, $3, 77.3, 12, $4, 'test')
     ON CONFLICT (vehicle_id) DO UPDATE SET gps_location_id = EXCLUDED.gps_location_id, latitude = EXCLUDED.latitude, recorded_at = EXCLUDED.recorded_at`,
    [vehicleId, g.id, lat, at]);
}

beforeAll(async () => {
  server = http.createServer(createApp());
  rt = attachRealtime(server, { throttleMs: 300, recheckMs: 3_600_000, corsOrigin: 'http://localhost:5173' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
  agencyA = await createAgency();
  agencyB = await createAgency();
  vA = await createVehicle({ agency_id: agencyA.id });
  vB = await createVehicle({ agency_id: agencyB.id });
  superU = await createUser('SUPER_ADMIN');
  auA = await createUser('AGENCY_USER', { agency_id: agencyA.id });
  auB = await createUser('AGENCY_USER', { agency_id: agencyB.id });
});

afterAll(async () => {
  for (const c of clients) c.close();
  await rt.close();
  await new Promise((r) => server.close(r));
});

describe('handshake', () => {
  it('rejects a missing token, a bad token and an inactive user', async () => {
    expect(await connectError(connect(undefined))).toBe('unauthorized');
    expect(await connectError(connect('not-a-jwt'))).toBe('unauthorized');
    const inactive = await createUser('SUPER_ADMIN', { status: 'INACTIVE' });
    expect(await connectError(connect(inactive.token))).toBe('unauthorized');
    const forged = signToken({ id: 99999999, role_key: 'SUPER_ADMIN' });
    expect(await connectError(connect(forged))).toBe('unauthorized');
  });

  it('joins only the server-computed scope room (client cannot choose)', async () => {
    const c = connect(auA.token, { query: { room: 'all' } });
    expect(await ready(c)).toEqual({ room: `agency:${agencyA.id}` });
    const s = connect(superU.token);
    expect(await ready(s)).toEqual({ room: 'all' });
  });
});

describe('vehicle:locations', () => {
  it('an agency user receives only its own vehicles; a super user receives all', async () => {
    const a = connect(auA.token); const b = connect(auB.token); const s = connect(superU.token);
    await Promise.all([ready(a), ready(b), ready(s)]);
    await setLatest(vA.id, 28.41);
    await setLatest(vB.id, 28.42);
    const pa = next(a, 'vehicle:locations'); const pb = next(b, 'vehicle:locations'); const ps = next(s, 'vehicle:locations');
    gpsEvents.emit('ingested', { vehicleIds: [vA.id, vB.id], insertedIds: [] });
    const [ma, mb, ms] = await Promise.all([pa, pb, ps]);
    expect(ma.map((x) => x.vehicle_id)).toEqual([vA.id]);
    expect(mb.map((x) => x.vehicle_id)).toEqual([vB.id]);
    expect(ms.map((x) => x.vehicle_id).sort()).toEqual([vA.id, vB.id].sort());
    expect(ma[0]).toMatchObject({ lat: 28.41, lng: 77.3, speed: 12, heading: 90, connection_status: 'ONLINE' });
    expect(Object.keys(ma[0]).sort()).toEqual(['connection_status', 'heading', 'ignition', 'lat', 'lng', 'recorded_at', 'speed', 'vehicle_id']);
  });

  it('throttles per room (≤ 1 emit / window) and merges to the latest point per vehicle', async () => {
    // Own server with a 5 s window: each ingested event costs ~2 DB round trips (~550 ms to Neon here),
    // so a short window would split events by DB latency instead of testing the merge.
    const s2 = http.createServer(createApp());
    const rt2 = attachRealtime(s2, { throttleMs: 5000, recheckMs: 3_600_000, corsOrigin: 'http://localhost:5173' });
    await new Promise((r) => s2.listen(0, '127.0.0.1', r));
    const a = ioClient(`http://127.0.0.1:${s2.address().port}`, { path: '/socket.io', auth: { token: auA.token }, transports: ['websocket'], reconnection: false });
    try {
      await ready(a);
      const got = collect(a, 'vehicle:locations');
      const t0 = Date.now();
      await setLatest(vA.id, 28.501);
      gpsEvents.emit('ingested', { vehicleIds: [vA.id], insertedIds: [] });
      await vi.waitFor(() => expect(got.length).toBe(1), { timeout: 4000, interval: 50 }); // first: immediate
      await setLatest(vA.id, 28.502);
      gpsEvents.emit('ingested', { vehicleIds: [vA.id], insertedIds: [] });
      await setLatest(vA.id, 28.503);
      gpsEvents.emit('ingested', { vehicleIds: [vA.id], insertedIds: [] });
      await vi.waitFor(() => expect(got.length).toBe(2), { timeout: 9000, interval: 100 });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(4900); // second emit waited for the window
      await sleep(500);
      expect(got.length).toBe(2); // the two later updates were merged into ONE emit
      expect(got[0].map((x) => x.lat)).toEqual([28.501]);
      expect(got[1]).toEqual([expect.objectContaining({ vehicle_id: vA.id, lat: 28.503 })]); // latest wins
    } finally {
      a.close();
      await rt2.close();
      await new Promise((r) => s2.close(r));
    }
  }, 30_000);
});

describe('pid:status', () => {
  it('is delivered to the assignment’s rooms only, with updated counts', async () => {
    const zw = await createZoneWard();
    const v = await createVehicle({ agency_id: agencyA.id });
    const asg = await makeAssignment({ pids: [[28.5, 77.2], [28.6, 77.2]], date: '2030-01-01', vehicle: v, routeWard: zw });
    await pool.query('UPDATE route_assignments SET agency_id = $2 WHERE id = $1', [asg.raId, agencyA.id]);
    await pool.query("UPDATE pid_daily_status SET visit_status = 'GPS_VISIT_CONFIRMED' WHERE route_assignment_id = $1 AND pid_id = $2", [asg.raId, asg.pidIds[0]]);
    const za = await createUser('ZONE_ADMIN', { zone_id: zw.zone.id });
    const a = connect(auA.token); const b = connect(auB.token); const z = connect(za.token);
    await Promise.all([ready(a), ready(b), ready(z)]);
    const gotB = collect(b, 'pid:status');
    const pa = next(a, 'pid:status'); const pz = next(z, 'pid:status');
    const changes = [{ route_assignment_id: asg.raId, pid_id: asg.pidIds[0], old_status: 'GPS_VISIT_CANDIDATE', new_status: 'GPS_VISIT_CONFIRMED' }];
    gpsEvents.emit('detected', { assignmentIds: [asg.raId], pidStatusChanges: changes });
    const [ma, mz] = await Promise.all([pa, pz]);
    expect(ma.changes).toEqual(changes);
    expect(ma.assignments).toEqual([{ route_assignment_id: asg.raId, vehicle_id: v.id, assigned: 2, confirmed: 1, candidate: 0, unavailable: 0 }]);
    expect(mz.changes).toEqual(changes); // zone room of the route
    await sleep(300);
    expect(gotB).toHaveLength(0);
  });
});

describe('periodic re-check', () => {
  it('disconnects a user deactivated while connected', async () => {
    const u = await createUser('AGENCY_USER', { agency_id: agencyA.id });
    const c = connect(u.token);
    await ready(c);
    const kicked = next(c, 'unauthorized');
    const disconnected = next(c, 'disconnect');
    await pool.query("UPDATE users SET status = 'INACTIVE' WHERE id = $1", [u.user.id]);
    await rt.recheckUsers();
    expect((await kicked).reason).toMatch(/no longer active/);
    expect(await disconnected).toBe('io server disconnect');
  });
});

describe('trimmed live payload + vehicle details', () => {
  it('view=map returns marker fields only; /live-vehicles/:id returns the side panel', async () => {
    const res = await import('supertest').then(({ default: request }) =>
      request(server).get(`/api/gps/live-vehicles?view=map&vehicle_id=${vA.id}`).set(bearer(superU.token)));
    expect(Object.keys(res.body.data.vehicles[0]).sort()).toEqual(
      ['connection_status', 'latitude', 'longitude', 'recorded_at', 'route_code', 'speed', 'vehicle_id', 'vehicle_number', 'vehicle_type']);
    const { default: request } = await import('supertest');
    const d = await request(server).get(`/api/gps/live-vehicles/${vA.id}`).set(bearer(superU.token));
    expect(d.status).toBe(200);
    expect(d.body.data).toMatchObject({ vehicle_id: vA.id, agency_name: agencyA.agency_name, connection_status: 'ONLINE' });
    expect(d.body.data.today).toMatchObject({ assigned_pids: 0, covered_pids: 0, remaining_pids: 0, gps_visit_events: 0 });
    expect((await request(server).get(`/api/gps/live-vehicles/${vB.id}`).set(bearer(auA.token))).status).toBe(404); // scope
  });
});
