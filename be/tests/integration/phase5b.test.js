// GUIDE #9 item 0: map-pids (unpaged, scoped) and /api/gps/config (non-secret allowlist).
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { env } from '../../src/config/env.js';
import { publicGpsConfig } from '../../src/routes/gpsRoutes.js';
import { createUser, createAgency, bearer } from '../helpers/fixtures.js';
import { makeAssignment } from '../helpers/detection.js';

let app; let admin;
beforeAll(async () => {
  app = createApp();
  admin = await createUser('SUPER_ADMIN');
});

describe('GET /api/route-assignments/:id/map-pids', () => {
  it('returns every snapshot PID (beyond one page) with snapshot coords and daily status; scoped', async () => {
    const pids = Array.from({ length: 120 }, (_, i) => [28.5 + i * 0.0001, 77.2]);
    pids.push(null); // no coordinates -> GPS_DATA_UNAVAILABLE
    const a = await makeAssignment({ pids, date: '2033-02-01' });
    await pool.query("UPDATE pid_daily_status SET visit_status = 'GPS_VISIT_CONFIRMED', min_distance_meters = 4.5 WHERE route_assignment_id = $1 AND pid_id = $2", [a.raId, a.pidIds[0]]);
    // the snapshot is immutable: moving the master PID must not move the map point
    await pool.query('UPDATE pids SET latitude = 10, longitude = 10 WHERE id = $1', [a.pidIds[0]]);

    const res = await request(app).get(`/api/route-assignments/${a.raId}/map-pids`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ route_assignment_id: a.raId, truncated: false, cap: 10000 });
    expect(d.pids).toHaveLength(121);
    expect(res.body.pagination).toBeUndefined();
    const first = d.pids.find((p) => p.pid_id === a.pidIds[0]);
    expect(first).toMatchObject({ latitude: 28.5, longitude: 77.2, visit_status: 'GPS_VISIT_CONFIRMED', min_distance_meters: 4.5 });
    expect(Object.keys(first).sort()).toEqual(['address', 'ambiguous', 'detection_count', 'first_visit_at', 'last_visit_at', 'latitude', 'longitude',
      'min_distance_meters', 'pid_id', 'pid_number', 'visit_status', 'ward_name', 'zone_name']);
    expect(d.pids.filter((p) => p.visit_status === 'GPS_DATA_UNAVAILABLE')).toEqual([expect.objectContaining({ latitude: null, longitude: null })]);

    const u = await createUser('AGENCY_USER', { agency_id: (await createAgency()).id });
    expect((await request(app).get(`/api/route-assignments/${a.raId}/map-pids`).set(bearer(u.token))).status).toBe(404);
    expect((await request(app).get('/api/route-assignments/99999999/map-pids').set(bearer(admin.token))).status).toBe(404);
  });
});

describe('GET /api/gps/config', () => {
  const SECRET = /KEY|SECRET|TOKEN|PASSWORD|URL|DSN|CREDENTIAL/i;

  it('returns only non-secret config, never any env key/value that looks like a secret', async () => {
    const res = await request(app).get('/api/gps/config').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ provider: env.GPS_PROVIDER, simulator: env.GPS_PROVIDER === 'simulator', poll_interval_seconds: env.GPS_POLL_INTERVAL_SECONDS });
    expect(typeof res.body.data.poll_enabled).toBe('boolean');
    expect(typeof res.body.data.detection_worker_enabled).toBe('boolean');
    for (const k of Object.keys(res.body.data)) expect(k).not.toMatch(SECRET);
    const body = JSON.stringify(res.body);
    for (const [k, v] of Object.entries(process.env)) {
      if (SECRET.test(k) && typeof v === 'string' && v.length >= 6) expect(body).not.toContain(v);
    }
  });

  it('stays an allowlist even if env gains secret-looking keys', () => {
    const out = publicGpsConfig({ ...env, GPS_PROVIDER: 'acme', GPS_API_KEY: 'k-123456', GPS_PROVIDER_TOKEN: 't-123456', GPS_PROVIDER_PASSWORD: 'p-123456' });
    expect(JSON.stringify(out)).not.toMatch(/k-123456|t-123456|p-123456/);
    expect(out.simulator).toBe(false);
  });

  it('requires gps:read', async () => {
    expect((await request(app).get('/api/gps/config')).status).toBe(401);
  });
});
