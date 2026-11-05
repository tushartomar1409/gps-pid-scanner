import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import {
  createZone, createWard, createAgency, createVehicle, createUser, bearer, uid,
} from '../helpers/fixtures.js';

let app;
let admin;
let zoneA; let zoneB; let wardA1; let wardB1; let agencyA; let agencyB;

beforeAll(async () => {
  app = createApp();
  admin = await createUser('SUPER_ADMIN');
  zoneA = await createZone();
  zoneB = await createZone();
  wardA1 = await createWard(zoneA.id);
  wardB1 = await createWard(zoneB.id);
  agencyA = await createAgency();
  agencyB = await createAgency();
});

describe('RBAC', () => {
  it('returns 403 when an AGENCY_USER tries to create a zone', async () => {
    const agencyUser = await createUser('AGENCY_USER', { agency_id: agencyA.id });
    const res = await request(app).post('/api/zones').set(bearer(agencyUser.token))
      .send({ zone_code: `X${uid()}`, zone_name: 'Nope' });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 for DEPARTMENT_ADMIN writing master data but allows reads', async () => {
    const dept = await createUser('DEPARTMENT_ADMIN');
    expect((await request(app).get('/api/zones').set(bearer(dept.token))).status).toBe(200);
    expect((await request(app).post('/api/agencies').set(bearer(dept.token)).send({ agency_name: `A${uid()}` })).status).toBe(403);
  });

  it('requires authentication for master APIs', async () => {
    expect((await request(app).get('/api/vehicles')).status).toBe(401);
  });
});

describe('zones', () => {
  it('creates (uppercasing code), updates, deactivates and audits', async () => {
    const code = `nit${uid()}`.toLowerCase();
    const created = await request(app).post('/api/zones').set(bearer(admin.token)).send({ zone_code: code, zone_name: ' NIT ' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ zone_code: code.toUpperCase(), zone_name: 'NIT', status: 'ACTIVE' });
    const id = created.body.data.id;

    const updated = await request(app).put(`/api/zones/${id}`).set(bearer(admin.token)).send({ zone_name: 'NIT Faridabad' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.zone_name).toBe('NIT Faridabad');

    const deact = await request(app).patch(`/api/zones/${id}/deactivate`).set(bearer(admin.token));
    expect(deact.status).toBe(200);
    expect(deact.body.data.status).toBe('INACTIVE');

    const still = await pool.query('SELECT 1 FROM zones WHERE id = $1', [id]);
    expect(still.rowCount).toBe(1); // soft delete only

    const logs = await pool.query(
      "SELECT action FROM activity_logs WHERE module = 'zones' AND reference_id = $1 ORDER BY id", [String(id)],
    );
    expect(logs.rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE', 'DEACTIVATE']);
  });

  it('returns 409 on duplicate zone_code', async () => {
    const res = await request(app).post('/api/zones').set(bearer(admin.token)).send({ zone_code: zoneA.zone_code, zone_name: 'dup' });
    expect(res.status).toBe(409);
  });

  it('rejects unknown body fields and empty updates (400)', async () => {
    const extra = await request(app).post('/api/zones').set(bearer(admin.token)).send({ zone_code: `Z${uid()}`, zone_name: 'x', id: 1 });
    expect(extra.status).toBe(400);
    const empty = await request(app).put(`/api/zones/${zoneA.id}`).set(bearer(admin.token)).send({});
    expect(empty.status).toBe(400);
  });

  it('returns 404 for a missing id and 400 for a non-numeric id', async () => {
    expect((await request(app).get('/api/zones/99999999').set(bearer(admin.token))).status).toBe(404);
    expect((await request(app).get('/api/zones/abc').set(bearer(admin.token))).status).toBe(400);
  });
});

describe('wards', () => {
  it('creates a ward and returns 422 for a non-existent zone', async () => {
    const ok = await request(app).post('/api/wards').set(bearer(admin.token))
      .send({ zone_id: zoneA.id, ward_number: `12-${uid()}`, ward_name: 'Ward 12' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.zone_name).toBe(zoneA.zone_name);

    const bad = await request(app).post('/api/wards').set(bearer(admin.token))
      .send({ zone_id: 99999999, ward_number: '1', ward_name: 'x' });
    expect(bad.status).toBe(422);
  });

  it('returns 409 when moving a ward to another zone while vehicles reference it (C1 composite FK)', async () => {
    const ward = await createWard(zoneA.id);
    await createVehicle({ zone_id: zoneA.id, ward_id: ward.id });
    const res = await request(app).put(`/api/wards/${ward.id}`).set(bearer(admin.token)).send({ zone_id: zoneB.id });
    expect(res.status).toBe(409);
  });

  it('filters by zone_id', async () => {
    const res = await request(app).get(`/api/wards?zone_id=${zoneB.id}`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((w) => w.zone_id === zoneB.id)).toBe(true);
  });
});

describe('agencies', () => {
  it('validates mobile and creates an agency', async () => {
    const bad = await request(app).post('/api/agencies').set(bearer(admin.token)).send({ agency_name: `A${uid()}`, mobile: 'abc' });
    expect(bad.status).toBe(400);
    const ok = await request(app).post('/api/agencies').set(bearer(admin.token))
      .send({ agency_name: `ABC Agency ${uid()}`, contact_person: 'R. Kumar', mobile: '+91 98765 43210' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.vehicle_count).toBe(0);
  });

  it('AGENCY_USER sees only its own agency', async () => {
    const u = await createUser('AGENCY_USER', { agency_id: agencyB.id });
    const res = await request(app).get('/api/agencies').set(bearer(u.token));
    expect(res.body.data.map((a) => a.id)).toEqual([agencyB.id]);
    expect((await request(app).get(`/api/agencies/${agencyA.id}`).set(bearer(u.token))).status).toBe(404);
  });
});

describe('vehicles', () => {
  it('normalises vehicle_number and derives zone from ward', async () => {
    const res = await request(app).post('/api/vehicles').set(bearer(admin.token)).send({
      vehicle_number: ' hr 38 ab 1234 ', vehicle_type: 'Tipper', gps_device_id: `GPS-${uid()}`,
      agency_id: agencyA.id, ward_id: wardA1.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      vehicle_number: 'HR38AB1234', zone_id: zoneA.id, ward_id: wardA1.id, agency_name: agencyA.agency_name,
    });
  });

  it('returns 409 on duplicate vehicle_number (after normalisation)', async () => {
    const res = await request(app).post('/api/vehicles').set(bearer(admin.token))
      .send({ vehicle_number: 'HR38 AB1234', vehicle_type: 'Tipper' });
    expect(res.status).toBe(409);
  });

  it('returns 409 on duplicate gps_device_id', async () => {
    const v = await createVehicle();
    const res = await request(app).post('/api/vehicles').set(bearer(admin.token))
      .send({ vehicle_number: `DL1C${uid()}`, vehicle_type: 'Tipper', gps_device_id: v.gps_device_id });
    expect(res.status).toBe(409);
  });

  it('returns 422 when ward does not belong to zone (create and update)', async () => {
    const create = await request(app).post('/api/vehicles').set(bearer(admin.token))
      .send({ vehicle_number: `UP16${uid()}`, vehicle_type: 'Tipper', zone_id: zoneA.id, ward_id: wardB1.id });
    expect(create.status).toBe(422);
    expect(create.body.message).toMatch(/does not belong/);

    const v = await createVehicle({ zone_id: zoneA.id, ward_id: wardA1.id });
    const update = await request(app).put(`/api/vehicles/${v.id}`).set(bearer(admin.token)).send({ ward_id: wardB1.id });
    expect(update.status).toBe(422);
  });

  it('DB itself rejects a ward/zone mismatch (C1) even bypassing the service', async () => {
    await expect(pool.query(
      "INSERT INTO vehicles (vehicle_number, vehicle_type, zone_id, ward_id) VALUES ($1, 'T', $2, $3)",
      [`RAW${uid()}`, zoneA.id, wardB1.id],
    )).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(
      "INSERT INTO vehicles (vehicle_number, vehicle_type, ward_id) VALUES ($1, 'T', $2)",
      [`RAW${uid()}`, wardB1.id],
    )).rejects.toMatchObject({ code: '23514' }); // ward without zone
  });

  it('AGENCY_USER lists only its agency vehicles (scope filtering)', async () => {
    const own1 = await createVehicle({ agency_id: agencyB.id });
    const own2 = await createVehicle({ agency_id: agencyB.id });
    const other = await createVehicle({ agency_id: agencyA.id });
    const u = await createUser('AGENCY_USER', { agency_id: agencyB.id });

    const res = await request(app).get('/api/vehicles?limit=100').set(bearer(u.token));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining([own1.id, own2.id]));
    expect(ids).not.toContain(other.id);
    expect(res.body.data.every((v) => v.agency_id === agencyB.id)).toBe(true);
    expect(res.body.pagination.total).toBe(ids.length);

    // Explicit filter for another agency cannot widen the scope.
    const widened = await request(app).get(`/api/vehicles?agency_id=${agencyA.id}`).set(bearer(u.token));
    expect(widened.body.data).toEqual([]);
    expect((await request(app).get(`/api/vehicles/${other.id}`).set(bearer(u.token))).status).toBe(404);
  });

  it('ZONE_ADMIN and WARD_SUPERVISOR are scoped to their zone / ward', async () => {
    const vA = await createVehicle({ zone_id: zoneA.id, ward_id: wardA1.id });
    const vB = await createVehicle({ zone_id: zoneB.id, ward_id: wardB1.id });
    const za = await createUser('ZONE_ADMIN', { zone_id: zoneA.id });
    const ws = await createUser('WARD_SUPERVISOR', { zone_id: zoneB.id, ward_id: wardB1.id });

    const zaIds = (await request(app).get('/api/vehicles?limit=100').set(bearer(za.token))).body.data.map((v) => v.id);
    expect(zaIds).toContain(vA.id);
    expect(zaIds).not.toContain(vB.id);

    const wsIds = (await request(app).get('/api/vehicles?limit=100').set(bearer(ws.token))).body.data.map((v) => v.id);
    expect(wsIds).toContain(vB.id);
    expect(wsIds).not.toContain(vA.id);
  });

  it('returns the standard pagination shape and enforces max limit 100', async () => {
    for (let i = 0; i < 3; i++) await createVehicle({ agency_id: agencyA.id }); // eslint-disable-line no-await-in-loop
    const res = await request(app).get(`/api/vehicles?page=2&limit=2&agency_id=${agencyA.id}`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: expect.any(String) });
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toEqual({
      page: 2, limit: 2, total: expect.any(Number), total_pages: Math.ceil(res.body.pagination.total / 2),
    });
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(4);

    expect((await request(app).get('/api/vehicles?limit=101').set(bearer(admin.token))).status).toBe(400);
    expect((await request(app).get('/api/vehicles?page=0').set(bearer(admin.token))).status).toBe(400);
  });

  it('search is parameterized (SQL meta-characters are harmless)', async () => {
    const res = await request(app).get(`/api/vehicles?search=${encodeURIComponent("' OR 1=1 --")}`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('users (SUPER_ADMIN only)', () => {
  it('returns 403 for non-super-admins', async () => {
    const dept = await createUser('DEPARTMENT_ADMIN');
    expect((await request(app).get('/api/users').set(bearer(dept.token))).status).toBe(403);
  });

  it('creates users enforcing role scope rules and never returns password_hash', async () => {
    const base = () => ({ name: 'Test', email: `u.${uid().toLowerCase()}@test.local`, password: 'Passw0rd!x' });

    const noZone = await request(app).post('/api/users').set(bearer(admin.token)).send({ ...base(), role_key: 'ZONE_ADMIN' });
    expect(noZone.status).toBe(422);

    const noAgency = await request(app).post('/api/users').set(bearer(admin.token)).send({ ...base(), role_key: 'AGENCY_USER' });
    expect(noAgency.status).toBe(422);

    const mismatch = await request(app).post('/api/users').set(bearer(admin.token))
      .send({ ...base(), role_key: 'WARD_SUPERVISOR', zone_id: zoneA.id, ward_id: wardB1.id });
    expect(mismatch.status).toBe(422);

    const ws = await request(app).post('/api/users').set(bearer(admin.token))
      .send({ ...base(), role_key: 'WARD_SUPERVISOR', ward_id: wardA1.id, agency_id: agencyA.id });
    expect(ws.status).toBe(201);
    expect(ws.body.data).toMatchObject({ role_key: 'WARD_SUPERVISOR', zone_id: zoneA.id, ward_id: wardA1.id, agency_id: null });
    expect(ws.body.data.password_hash).toBeUndefined();

    const za = await request(app).post('/api/users').set(bearer(admin.token))
      .send({ ...base(), role_key: 'ZONE_ADMIN', zone_id: zoneA.id, ward_id: wardA1.id });
    expect(za.status).toBe(201);
    expect(za.body.data.ward_id).toBeNull(); // irrelevant scope cleared

    const list = await request(app).get('/api/users?limit=100').set(bearer(admin.token));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toMatch(/password_hash/);

    const audit = await pool.query("SELECT details FROM activity_logs WHERE module = 'users' AND action = 'CREATE'");
    expect(JSON.stringify(audit.rows)).not.toMatch(/password/);
  });

  it('rejects weak passwords and duplicate emails (case-insensitive)', async () => {
    const weak = await request(app).post('/api/users').set(bearer(admin.token))
      .send({ name: 'x', email: `w.${uid().toLowerCase()}@test.local`, password: 'short', role_key: 'DEPARTMENT_ADMIN' });
    expect(weak.status).toBe(400);
    const dup = await request(app).post('/api/users').set(bearer(admin.token))
      .send({ name: 'x', email: admin.user.email.toUpperCase(), password: 'Passw0rd!x', role_key: 'DEPARTMENT_ADMIN' });
    expect(dup.status).toBe(409);
  });

  it('allows a password change that works for login, and blocks self-deactivation', async () => {
    const u = await createUser('DEPARTMENT_ADMIN');
    const upd = await request(app).put(`/api/users/${u.user.id}`).set(bearer(admin.token)).send({ password: 'NewPassw0rd!' });
    expect(upd.status).toBe(200);
    const login = await request(createApp()).post('/api/auth/login').send({ email: u.user.email, password: 'NewPassw0rd!' });
    expect(login.status).toBe(200);

    expect((await request(app).patch(`/api/users/${admin.user.id}/deactivate`).set(bearer(admin.token))).status).toBe(422);
    const deact = await request(app).patch(`/api/users/${u.user.id}/deactivate`).set(bearer(admin.token));
    expect(deact.body.data.status).toBe('INACTIVE');
  });
});
