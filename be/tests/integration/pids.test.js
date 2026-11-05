import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import {
  createUser, createAgency, createZoneWard, createPid, createRoute, addRoutePids, bearer, uid,
} from '../helpers/fixtures.js';

let app; let admin; let zw1; let zw2; let agency; let otherAgency;

beforeAll(async () => {
  app = createApp();
  admin = await createUser('SUPER_ADMIN');
  zw1 = await createZoneWard();
  zw2 = await createZoneWard();
  agency = await createAgency();
  otherAgency = await createAgency();
});

describe('PID CRUD', () => {
  it('creates with normalised number, derived zone, coord_status IMPORTED and bbox warning', async () => {
    const num = ` pid-${uid().toLowerCase()} `;
    const res = await request(app).post('/api/pids').set(bearer(admin.token))
      .send({ pid_number: num, ward_id: zw1.ward.id, address: 'H.No 12, Sector 7', latitude: 28.4082, longitude: 77.3178 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      pid_number: num.trim().toUpperCase(), zone_id: zw1.zone.id, coord_status: 'IMPORTED', latitude: 28.4082, longitude: 77.3178,
    });
    expect(res.body.data.warning).toBeUndefined();

    const outside = await request(app).post('/api/pids').set(bearer(admin.token))
      .send({ pid_number: `P${uid()}`, ward_id: zw1.ward.id, latitude: 51.5, longitude: -0.12 });
    expect(outside.status).toBe(201);
    expect(outside.body.data.warning).toMatch(/outside the configured service area/);
  });

  it('creates without coordinates as MISSING and rejects half coordinates', async () => {
    const ok = await request(app).post('/api/pids').set(bearer(admin.token)).send({ pid_number: `P${uid()}`, ward_id: zw1.ward.id });
    expect(ok.body.data.coord_status).toBe('MISSING');
    const half = await request(app).post('/api/pids').set(bearer(admin.token)).send({ pid_number: `P${uid()}`, ward_id: zw1.ward.id, latitude: 28.4 });
    expect(half.status).toBe(400);
  });

  it('rejects duplicate pid_number (409) and coordinates via PUT (400)', async () => {
    const p = await createPid({ zone_id: zw1.zone.id, ward_id: zw1.ward.id });
    const dup = await request(app).post('/api/pids').set(bearer(admin.token)).send({ pid_number: p.pid_number.toLowerCase(), ward_id: zw1.ward.id });
    expect(dup.status).toBe(409);
    const put = await request(app).put(`/api/pids/${p.id}`).set(bearer(admin.token)).send({ latitude: 1, longitude: 1 });
    expect(put.status).toBe(400);
  });

  it('blocks moving a PID to another ward while it is on a route in its ward (409)', async () => {
    const zw = await createZoneWard();
    const otherWard = (await pool.query('INSERT INTO wards (zone_id, ward_number, ward_name) VALUES ($1, $2, $3) RETURNING id', [zw.zone.id, `X${uid()}`, 'x'])).rows[0];
    const p = await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    const r = await createRoute({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    await addRoutePids(r.id, [p.id]);
    const res = await request(app).put(`/api/pids/${p.id}`).set(bearer(admin.token)).send({ ward_id: otherWard.id });
    expect(res.status).toBe(409);
    expect(res.body.errors[0].message).toContain(r.route_code);
  });

  it('filters by route_id, has_coords, coord_status and searches address', async () => {
    const zw = await createZoneWard();
    const a = await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id, latitude: 28.1, longitude: 77.1 });
    const b = await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    await pool.query("UPDATE pids SET address = 'Near Shiv Mandir, Gali 4' WHERE id = $1", [b.id]);
    const r = await createRoute({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    await addRoutePids(r.id, [a.id]);

    const byRoute = await request(app).get(`/api/pids?route_id=${r.id}`).set(bearer(admin.token));
    expect(byRoute.body.data.map((p) => p.id)).toEqual([a.id]);
    const noCoords = await request(app).get(`/api/pids?ward_id=${zw.ward.id}&has_coords=false`).set(bearer(admin.token));
    expect(noCoords.body.data.map((p) => p.id)).toEqual([b.id]);
    const withCoords = await request(app).get(`/api/pids?ward_id=${zw.ward.id}&has_coords=true&coord_status=IMPORTED`).set(bearer(admin.token));
    expect(withCoords.body.data.map((p) => p.id)).toEqual([a.id]);
    const search = await request(app).get(`/api/pids?search=${encodeURIComponent('shiv mandir')}`).set(bearer(admin.token));
    expect(search.body.data.map((p) => p.id)).toEqual([b.id]);
    expect((await request(app).get('/api/pids?has_coords=maybe').set(bearer(admin.token))).status).toBe(400);
  });
});

describe('PID scope', () => {
  it('AGENCY_USER sees PIDs through its routes or assignment snapshots only', async () => {
    const zw = await createZoneWard();
    const viaRoute = await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    const viaSnapshot = await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    const hidden = await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    const otherRoute = await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id });

    const own = await createRoute({ zone_id: zw.zone.id, ward_id: zw.ward.id, agency_id: agency.id });
    await addRoutePids(own.id, [viaRoute.id]);
    const foreign = await createRoute({ zone_id: zw.zone.id, ward_id: zw.ward.id, agency_id: otherAgency.id });
    await addRoutePids(foreign.id, [otherRoute.id]);
    // Snapshot from an old assignment of the agency on a route that no longer includes the PID.
    const v = (await pool.query("INSERT INTO vehicles (vehicle_number, vehicle_type) VALUES ($1, 'T') RETURNING id", [`V${uid()}`])).rows[0];
    const ra = (await pool.query(
      `INSERT INTO route_assignments (route_id, vehicle_id, agency_id, operational_date) VALUES ($1, $2, $3, '2026-01-01') RETURNING id`,
      [foreign.id, v.id, agency.id],
    )).rows[0];
    await pool.query('INSERT INTO route_assignment_pids (route_assignment_id, pid_id) VALUES ($1, $2)', [ra.id, viaSnapshot.id]);

    const u = await createUser('AGENCY_USER', { agency_id: agency.id });
    const res = await request(app).get(`/api/pids?ward_id=${zw.ward.id}&limit=100`).set(bearer(u.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.id).sort()).toEqual([viaRoute.id, viaSnapshot.id].sort());
    expect((await request(app).get(`/api/pids/${hidden.id}`).set(bearer(u.token))).status).toBe(404);
    expect((await request(app).post('/api/pids').set(bearer(u.token)).send({ pid_number: `P${uid()}`, ward_id: zw.ward.id })).status).toBe(403);
  });

  it('ZONE_ADMIN and WARD_SUPERVISOR are restricted by zone / ward columns', async () => {
    const p1 = await createPid({ zone_id: zw1.zone.id, ward_id: zw1.ward.id });
    const p2 = await createPid({ zone_id: zw2.zone.id, ward_id: zw2.ward.id });
    const za = await createUser('ZONE_ADMIN', { zone_id: zw1.zone.id });
    const ws = await createUser('WARD_SUPERVISOR', { zone_id: zw2.zone.id, ward_id: zw2.ward.id });
    const zaIds = (await request(app).get('/api/pids?limit=100').set(bearer(za.token))).body.data.map((p) => p.id);
    expect(zaIds).toContain(p1.id);
    expect(zaIds).not.toContain(p2.id);
    const wsIds = (await request(app).get('/api/pids?limit=100').set(bearer(ws.token))).body.data.map((p) => p.id);
    expect(wsIds).toContain(p2.id);
    expect(wsIds).not.toContain(p1.id);
  });
});

describe('PATCH /api/pids/:id/coordinates', () => {
  it('sets MANUALLY_CORRECTED, audits old/new, warns outside bbox, leaves snapshots untouched', async () => {
    const p = await createPid({ zone_id: zw1.zone.id, ward_id: zw1.ward.id, latitude: 28.5, longitude: 77.2 });
    const r = await createRoute({ zone_id: zw1.zone.id, ward_id: zw1.ward.id });
    const v = (await pool.query("INSERT INTO vehicles (vehicle_number, vehicle_type) VALUES ($1, 'T') RETURNING id", [`V${uid()}`])).rows[0];
    const ra = (await pool.query(
      "INSERT INTO route_assignments (route_id, vehicle_id, operational_date) VALUES ($1, $2, '2026-01-02') RETURNING id", [r.id, v.id])).rows[0];
    await pool.query('INSERT INTO route_assignment_pids (route_assignment_id, pid_id, pid_latitude, pid_longitude) VALUES ($1, $2, 28.5, 77.2)', [ra.id, p.id]);

    const res = await request(app).patch(`/api/pids/${p.id}/coordinates`).set(bearer(admin.token)).send({ latitude: 28.51, longitude: 77.21 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ latitude: 28.51, longitude: 77.21, coord_status: 'MANUALLY_CORRECTED' });
    expect(res.body.data.warning).toBeUndefined();

    const log = await pool.query("SELECT details FROM activity_logs WHERE action = 'UPDATE_COORDINATES' AND reference_id = $1", [String(p.id)]);
    expect(log.rows[0].details).toMatchObject({ old: { latitude: 28.5, longitude: 77.2 }, new: { latitude: 28.51, longitude: 77.21 } });

    const snap = await pool.query('SELECT pid_latitude, pid_longitude FROM route_assignment_pids WHERE route_assignment_id = $1', [ra.id]);
    expect(snap.rows[0]).toEqual({ pid_latitude: 28.5, pid_longitude: 77.2 });

    const swapped = await request(app).patch(`/api/pids/${p.id}/coordinates`).set(bearer(admin.token)).send({ latitude: 77.21, longitude: 28.51, verified: true });
    expect(swapped.body.data.coord_status).toBe('VERIFIED');
    expect(swapped.body.data.warning).toMatch(/swapped/);

    expect((await request(app).patch(`/api/pids/${p.id}/coordinates`).set(bearer(admin.token)).send({ latitude: 95, longitude: 1 })).status).toBe(400);
  });
});

describe('GET /api/pids/map', () => {
  it('returns points in the bbox, honours filters, limit/truncated, and validates bbox', async () => {
    const zw = await createZoneWard();
    // A tiny, unique area far from other test data.
    const base = { lat: 10.5 + Math.random() * 0.1, lng: 80.5 + Math.random() * 0.1 };
    const inside = [];
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      inside.push(await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id, latitude: base.lat + i * 0.0001, longitude: base.lng + i * 0.0001 }));
    }
    await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id, latitude: base.lat + 1, longitude: base.lng + 1 }); // outside
    await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id, latitude: base.lat, longitude: base.lng, status: 'INACTIVE' });
    const bbox = [base.lng - 0.001, base.lat - 0.001, base.lng + 0.001, base.lat + 0.001].join(',');

    const res = await request(app).get(`/api/pids/map?bbox=${bbox}`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.points.map((p) => p.id).sort()).toEqual(inside.map((p) => p.id).sort());
    expect(res.body.data.truncated).toBe(false);
    expect(Object.keys(res.body.data.points[0]).sort()).toEqual(['coord_status', 'id', 'latitude', 'longitude', 'pid_number']);

    const limited = await request(app).get(`/api/pids/map?bbox=${bbox}&limit=2`).set(bearer(admin.token));
    expect(limited.body.data).toMatchObject({ truncated: true, count: 2 });

    const otherWard = await request(app).get(`/api/pids/map?bbox=${bbox}&ward_id=${zw1.ward.id}`).set(bearer(admin.token));
    expect(otherWard.body.data.points).toEqual([]);

    for (const bad of ['1,2,3', '10,10,5,5', 'a,b,c,d', '-190,0,0,1']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await request(app).get(`/api/pids/map?bbox=${bad}`).set(bearer(admin.token))).status).toBe(400);
    }
    expect((await request(app).get('/api/pids/map').set(bearer(admin.token))).status).toBe(400);
    expect((await request(app).get(`/api/pids/map?bbox=${bbox}&limit=10001`).set(bearer(admin.token))).status).toBe(400);
  });
});
