// GUIDE #11 E: /api/health (liveness), /api/health/ready (503 when not ready), /api/health/details (SUPER_ADMIN).
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { registerJob } from '../../src/services/opsService.js';
import { createUser, createVehicle, bearer } from '../helpers/fixtures.js';

let app;
beforeAll(() => {
  app = createApp();
});

describe('health', () => {
  it('liveness and readiness (migrations up to date)', async () => {
    expect((await request(app).get('/api/health')).body.data).toEqual({ status: 'up' });
    const r = await request(app).get('/api/health/ready');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ready: true, checks: { database: 'up', migrations: 'up_to_date' }, pending_migrations: [] });
  });

  it('readiness is 503 while a migration is pending', async () => {
    const { rows: [m] } = await pool.query('DELETE FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations) RETURNING version, applied_at');
    try {
      const r = await request(app).get('/api/health/ready');
      expect(r.status).toBe(503);
      expect(r.body.data).toMatchObject({ ready: false, checks: { migrations: 'pending' }, pending_migrations: [m.version] });
    } finally {
      await pool.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [m.version, m.applied_at]);
    }
  });

  it('details: SUPER_ADMIN only; jobs, detection lag, poll status, archive, partitions', async () => {
    const dept = await createUser('DEPARTMENT_ADMIN');
    expect((await request(app).get('/api/health/details').set(bearer(dept.token))).status).toBe(403);
    expect((await request(app).get('/api/health/details')).status).toBe(401);

    registerJob('detection_worker', () => ({ enabled: true, leader: true }));
    const v = await createVehicle();
    await pool.query("INSERT INTO gps_locations (vehicle_id, device_id, latitude, longitude, recorded_at) VALUES ($1, 'D', 28.4, 77.3, now() - interval '90 seconds')", [v.id]);
    const admin = await createUser('SUPER_ADMIN');
    const r = await request(app).get('/api/health/details').set(bearer(admin.token));
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.jobs.detection_worker).toEqual({ enabled: true, leader: true });
    expect(d.detection.unprocessed_points).toBeGreaterThanOrEqual(1);
    expect(d.detection.lag_seconds).toBeGreaterThanOrEqual(85);
    expect(d.gps_poll).toHaveProperty('state');
    expect(d.archive).toHaveProperty('recent');
    expect(d.gps_partitions.partitions.some((p) => p.is_default)).toBe(true);
    expect(d.gps_partitions.partitions.filter((p) => !p.is_default).length).toBeGreaterThanOrEqual(4);
    expect(typeof d.gps_partitions.default_rows).toBe('number');
    expect(JSON.stringify(d)).not.toMatch(/postgres(ql)?:\/\/|JWT_SECRET|password/i);
    await pool.query('UPDATE gps_locations SET processed_at = now() WHERE vehicle_id = $1', [v.id]);
  });
});
