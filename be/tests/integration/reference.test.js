import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { createZone, createWard, createAgency, createUser, bearer } from '../helpers/fixtures.js';

let app; let admin; let zoneA; let zoneB; let wardA; let wardB; let agencyA; let agencyB;

beforeAll(async () => {
  app = createApp();
  admin = await createUser('SUPER_ADMIN');
  zoneA = await createZone();
  zoneB = await createZone();
  wardA = await createWard(zoneA.id);
  wardB = await createWard(zoneB.id);
  agencyA = await createAgency();
  agencyB = await createAgency();
});

describe('GET /api/roles', () => {
  it('returns role_key/role_name for users:read holders', async () => {
    const res = await request(app).get('/api/roles').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => r.role_key)).toEqual(
      ['SUPER_ADMIN', 'DEPARTMENT_ADMIN', 'ZONE_ADMIN', 'WARD_SUPERVISOR', 'AGENCY_USER'],
    );
    expect(Object.keys(res.body.data[0])).toEqual(['role_key', 'role_name']);
  });

  it('is forbidden without users:read', async () => {
    const dept = await createUser('DEPARTMENT_ADMIN');
    expect((await request(app).get('/api/roles').set(bearer(dept.token))).status).toBe(403);
  });
});

describe('GET /api/lookups', () => {
  it('returns active zones, wards and agencies (unpaginated)', async () => {
    const inactive = await createZone();
    await pool.query("UPDATE zones SET status = 'INACTIVE' WHERE id = $1", [inactive.id]);

    const res = await request(app).get('/api/lookups?types=zones,wards,agencies').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.pagination).toBeUndefined();
    const { zones, wards, agencies } = res.body.data;
    expect(zones.map((z) => z.id)).toEqual(expect.arrayContaining([zoneA.id, zoneB.id]));
    expect(zones.map((z) => z.id)).not.toContain(inactive.id);
    expect(wards.find((w) => w.id === wardA.id)).toEqual({ id: wardA.id, name: wardA.ward_name, code: wardA.ward_number, zone_id: zoneA.id });
    expect(agencies.find((a) => a.id === agencyA.id)).toMatchObject({ id: agencyA.id, name: agencyA.agency_name });
  });

  it('applies row scope', async () => {
    const za = await createUser('ZONE_ADMIN', { zone_id: zoneA.id });
    const z = await request(app).get('/api/lookups?types=zones,wards').set(bearer(za.token));
    expect(z.body.data.zones.map((x) => x.id)).toEqual([zoneA.id]);
    expect(z.body.data.wards.every((w) => w.zone_id === zoneA.id)).toBe(true);
    expect(z.body.data.wards.map((w) => w.id)).not.toContain(wardB.id);

    const au = await createUser('AGENCY_USER', { agency_id: agencyB.id });
    const a = await request(app).get('/api/lookups?types=agencies').set(bearer(au.token));
    expect(a.body.data.agencies.map((x) => x.id)).toEqual([agencyB.id]);
  });

  it('validates types and requires authentication', async () => {
    expect((await request(app).get('/api/lookups?types=zones,bogus').set(bearer(admin.token))).status).toBe(400);
    expect((await request(app).get('/api/lookups').set(bearer(admin.token))).status).toBe(400);
    expect((await request(app).get('/api/lookups?types=zones')).status).toBe(401);
  });
});

describe('CORS', () => {
  it('allows the configured origin', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
  it('does not allow other origins', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'http://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
