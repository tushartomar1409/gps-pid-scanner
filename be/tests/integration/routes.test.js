import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import {
  createUser, createAgency, createZoneWard, createWard, createPid, createRoute, addRoutePids, bearer, uid,
} from '../helpers/fixtures.js';

let app; let admin; let zw; let agency;

beforeAll(async () => {
  app = createApp();
  admin = await createUser('SUPER_ADMIN');
  zw = await createZoneWard();
  agency = await createAgency();
});

const line = (n) => ({ type: 'LineString', coordinates: Array.from({ length: n }, (_, i) => [77.3 + i * 0.0001, 28.4 + i * 0.0001]) });

describe('routes CRUD', () => {
  it('creates with uppercase code, derived zone and valid geometry', async () => {
    const res = await request(app).post('/api/routes').set(bearer(admin.token)).send({
      route_code: `route-${uid().toLowerCase()}`, route_name: 'Sector 7 loop', ward_id: zw.ward.id, agency_id: agency.id,
      start_latitude: 28.4, start_longitude: 77.3, end_latitude: 28.41, end_longitude: 77.31, route_geometry: line(3),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.route_code).toMatch(/^ROUTE-[A-F0-9]+$/);
    expect(res.body.data).toMatchObject({ zone_id: zw.zone.id, agency_name: agency.agency_name, pid_count: 0 });
    expect(res.body.data.route_geometry.coordinates).toHaveLength(3);
  });

  it('validates GeoJSON LineString geometry', async () => {
    const base = { route_name: 'x', ward_id: zw.ward.id };
    const bad = [
      { type: 'Point', coordinates: [77, 28] },
      { type: 'LineString', coordinates: [[77, 28]] }, // < 2 points
      { type: 'LineString', coordinates: [[77, 28], [200, 28]] }, // lng out of range
      { type: 'LineString', coordinates: [[77, 28], [77, 95]] }, // lat out of range
      { type: 'LineString', coordinates: [[77, 28, 5], [77, 28]] }, // 3D position
      line(10_001),
    ];
    for (const g of bad) {
      // eslint-disable-next-line no-await-in-loop
      const r = await request(app).post('/api/routes').set(bearer(admin.token)).send({ ...base, route_code: `G${uid()}`, route_geometry: g });
      expect(r.status).toBe(400);
    }
    const ok = await request(app).post('/api/routes').set(bearer(admin.token)).send({ ...base, route_code: `G${uid()}`, route_geometry: line(10_000) });
    expect(ok.status).toBe(201);
  });

  it('AGENCY_USER only sees its agency routes', async () => {
    const own = await createRoute({ zone_id: zw.zone.id, ward_id: zw.ward.id, agency_id: agency.id });
    const other = await createRoute({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    const u = await createUser('AGENCY_USER', { agency_id: agency.id });
    const ids = (await request(app).get('/api/routes?limit=100').set(bearer(u.token))).body.data.map((r) => r.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(other.id);
  });
});

describe('assign-pids', () => {
  it('add / replace (ordered) / remove, and lists route PIDs ordered by sequence', async () => {
    const r = await createRoute({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    const p = [];
    for (let i = 0; i < 4; i++) p.push(await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id })); // eslint-disable-line no-await-in-loop

    const add = await request(app).post(`/api/routes/${r.id}/assign-pids`).set(bearer(admin.token)).send({ pid_ids: [p[0].id, p[1].id, p[1].id], mode: 'add' });
    expect(add.body.data).toMatchObject({ added: 2, removed: 0, total: 2 });

    const add2 = await request(app).post(`/api/routes/${r.id}/assign-pids`).set(bearer(admin.token)).send({ pid_ids: [p[1].id, p[2].id], mode: 'add' });
    expect(add2.body.data).toMatchObject({ added: 1, total: 3 });

    const rep = await request(app).post(`/api/routes/${r.id}/assign-pids`).set(bearer(admin.token)).send({ pid_ids: [p[3].id, p[0].id], mode: 'replace' });
    expect(rep.body.data).toMatchObject({ added: 1, removed: 2, total: 2 });
    const listed = await request(app).get(`/api/routes/${r.id}/pids`).set(bearer(admin.token));
    expect(listed.body.data.map((x) => x.id)).toEqual([p[3].id, p[0].id]);
    expect(listed.body.pagination.total).toBe(2);

    const rem = await request(app).post(`/api/routes/${r.id}/assign-pids`).set(bearer(admin.token)).send({ pid_ids: [p[3].id], mode: 'remove' });
    expect(rem.body.data).toMatchObject({ removed: 1, total: 1 });
  });

  it('422 with offending ids for wrong ward, inactive or missing PIDs; PID may be on several routes', async () => {
    const r = await createRoute({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    const r2 = await createRoute({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    const otherWard = await createWard(zw.zone.id);
    const good = await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    const wrong = await createPid({ zone_id: zw.zone.id, ward_id: otherWard.id });
    const inactive = await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id, status: 'INACTIVE' });

    const res = await request(app).post(`/api/routes/${r.id}/assign-pids`).set(bearer(admin.token))
      .send({ pid_ids: [good.id, wrong.id, inactive.id, 99999999], mode: 'add' });
    expect(res.status).toBe(422);
    const byMsg = Object.fromEntries(res.body.errors.map((e) => [e.message, e.ids]));
    expect(byMsg["PIDs are not in the route's ward"]).toEqual([wrong.id]);
    expect(byMsg['PIDs are inactive']).toEqual([inactive.id]);
    expect(byMsg['PIDs not found']).toEqual([99999999]);
    expect((await pool.query('SELECT count(*)::int AS n FROM route_pids WHERE route_id = $1', [r.id])).rows[0].n).toBe(0); // atomic

    await addRoutePids(r.id, [good.id]);
    const second = await request(app).post(`/api/routes/${r2.id}/assign-pids`).set(bearer(admin.token)).send({ pid_ids: [good.id], mode: 'add' });
    expect(second.status).toBe(200);
  });

  it('caps pid_ids at 5000 and blocks moving a route with PIDs to another ward', async () => {
    const r = await createRoute({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    const tooMany = Array.from({ length: 5001 }, (_, i) => i + 1);
    expect((await request(app).post(`/api/routes/${r.id}/assign-pids`).set(bearer(admin.token)).send({ pid_ids: tooMany, mode: 'add' })).status).toBe(400);

    const p = await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id });
    await addRoutePids(r.id, [p.id]);
    const otherWard = await createWard(zw.zone.id);
    expect((await request(app).put(`/api/routes/${r.id}`).set(bearer(admin.token)).send({ ward_id: otherWard.id })).status).toBe(409);
  });
});
