import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { createUser, createAgency, bearer } from '../helpers/fixtures.js';

let app; let agencyUser;

beforeAll(async () => {
  app = createApp();
  agencyUser = await createUser('AGENCY_USER', { agency_id: (await createAgency()).id });
  // A sensitive-looking setting that must never be exposed.
  await pool.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('gps.provider_api_key', '"secret-123"')
                    ON CONFLICT (setting_key) DO NOTHING`);
});
afterAll(async () => {
  await pool.query("DELETE FROM system_settings WHERE setting_key = 'gps.provider_api_key'");
});

describe('GET /api/settings/public', () => {
  it('returns exactly the whitelisted keys to any authenticated user (lowest role)', async () => {
    const res = await request(app).get('/api/settings/public').set(bearer(agencyUser.token));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['app.timezone', 'detection.radius_m', 'geo.service_area_bbox', 'gps.offline_after_seconds'],
    );
    expect(res.body.data['geo.service_area_bbox']).toEqual({ min_lat: 6, max_lat: 37.5, min_lng: 68, max_lng: 97.5 });
    expect(res.body.data['app.timezone']).toBe('Asia/Kolkata');
    expect(res.body.data['detection.radius_m']).toBe(30);
    expect(res.body.data['gps.offline_after_seconds']).toBe(300);
  });

  it('never returns non-whitelisted keys, even sensitive ones present in the DB', async () => {
    const res = await request(app).get('/api/settings/public').set(bearer(agencyUser.token));
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('provider_api_key');
    expect(body).not.toContain('secret-123');
    expect(body).not.toContain('detection.consecutive_points'); // real but not whitelisted
  });

  it('reflects DB changes for whitelisted keys and requires authentication', async () => {
    await pool.query("UPDATE system_settings SET setting_value = '45' WHERE setting_key = 'detection.radius_m'");
    try {
      const res = await request(app).get('/api/settings/public').set(bearer(agencyUser.token));
      expect(res.body.data['detection.radius_m']).toBe(45);
    } finally {
      await pool.query("UPDATE system_settings SET setting_value = '30' WHERE setting_key = 'detection.radius_m'");
    }
    expect((await request(app).get('/api/settings/public')).status).toBe(401);
  });
});
