import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { redactSecrets } from '../../src/routes/activityLogRoutes.js';
import { createUser, bearer, uid } from '../helpers/fixtures.js';

let app; let admin;
beforeAll(async () => {
  app = createApp();
  admin = await createUser('SUPER_ADMIN');
});

describe('GET /api/activity-logs', () => {
  it('redactSecrets removes secret-looking values at any depth (booleans like password_changed are kept)', () => {
    expect(redactSecrets({ a: 1, password_hash: '$2b$', nested: { token: 'jwt', list: [{ api_key: 'k' }] }, password_changed: true }))
      .toEqual({ a: 1, password_hash: '[REDACTED]', nested: { token: '[REDACTED]', list: [{ api_key: '[REDACTED]' }] }, password_changed: true });
  });

  it('never returns hashes / tokens, even if a writer stored them; filters + pagination; SUPER_ADMIN only', async () => {
    const ref = `REF${uid()}`;
    await pool.query(
      `INSERT INTO activity_logs (user_id, action, module, reference_id, details) VALUES
         ($1, 'UPDATE', 'users', $2, '{"name":"x","password_hash":"$2b$12$abc","password_changed":true}'),
         ($1, 'UPDATE', 'settings', $2, '{"old":1,"new":2,"secret":"s3cr3t","Authorization":"Bearer abc.def"}')`,
      [admin.user.id, ref]);
    const res = await request(app).get(`/api/activity-logs?reference_id=${ref}&limit=10`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(2);
    const body = JSON.stringify(res.body);
    for (const s of ['$2b$12$abc', 's3cr3t', 'abc.def']) expect(body).not.toContain(s);
    expect(res.body.data.find((r) => r.module === 'users').details).toMatchObject({ name: 'x', password_changed: true, password_hash: '[REDACTED]' });

    const byModule = await request(app).get(`/api/activity-logs?reference_id=${ref}&module=settings`).set(bearer(admin.token));
    expect(byModule.body.data.map((r) => r.module)).toEqual(['settings']);
    expect((await request(app).get('/api/activity-logs?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z').set(bearer(admin.token))).body.data).toEqual([]);

    const dept = await createUser('DEPARTMENT_ADMIN');
    expect((await request(app).get('/api/activity-logs').set(bearer(dept.token))).status).toBe(403);
  });

  it('real writers never store password hashes: user create/update audit rows', async () => {
    const created = await request(app).post('/api/users').set(bearer(admin.token))
      .send({ name: 'Audit Probe', email: `audit.${uid().toLowerCase()}@test.local`, password: 'Passw0rd!x', role_key: 'DEPARTMENT_ADMIN' });
    await request(app).put(`/api/users/${created.body.data.id}`).set(bearer(admin.token)).send({ password: 'NewPassw0rd!' });
    const raw = await pool.query("SELECT details FROM activity_logs WHERE module = 'users' AND reference_id = $1", [String(created.body.data.id)]);
    const stored = JSON.stringify(raw.rows);
    expect(stored).not.toMatch(/\$2[aby]\$/); // no bcrypt hash anywhere
    expect(stored).not.toContain('Passw0rd');
    expect(raw.rows.some((r) => r.details.password_changed === true)).toBe(true);
  });
});
