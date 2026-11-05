import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { createUser, bearer } from '../helpers/fixtures.js';

describe('auth', () => {
  let admin;
  let app;

  beforeAll(async () => {
    admin = await createUser('SUPER_ADMIN');
    app = createApp();
  });

  it('logs in with valid credentials and returns token + profile without password_hash', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: admin.user.email.toUpperCase(), password: admin.password });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTypeOf('string');
    expect(res.body.data.user.email).toBe(admin.user.email);
    expect(res.body.data.user.role_key).toBe('SUPER_ADMIN');
    expect(res.body.data.user.permissions).toEqual(['*']);
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash/);

    const payload = jwt.decode(res.body.data.token);
    expect(payload).toMatchObject({ sub: String(admin.user.id), role_key: 'SUPER_ADMIN', zone_id: null, ward_id: null, agency_id: null });

    const log = await pool.query("SELECT 1 FROM activity_logs WHERE action = 'LOGIN' AND user_id = $1", [admin.user.id]);
    expect(log.rowCount).toBe(1);
  });

  it('rejects a wrong password with a generic message and logs LOGIN_FAILED', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: admin.user.email, password: 'wrong-Passw0rd' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, message: 'Invalid email or password', request_id: expect.any(String) });
    expect(res.headers['x-request-id']).toBe(res.body.request_id);
    const log = await pool.query(
      "SELECT details FROM activity_logs WHERE action = 'LOGIN_FAILED' AND reference_id = $1", [String(admin.user.id)],
    );
    expect(log.rows[0].details.reason).toBe('BAD_PASSWORD');
  });

  it('returns the same generic error for an unknown email', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@test.local', password: 'whatever1' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password');
  });

  it('rejects login for an inactive user', async () => {
    const inactive = await createUser('SUPER_ADMIN', { status: 'INACTIVE' });
    const res = await request(app).post('/api/auth/login').send({ email: inactive.user.email, password: inactive.password });
    expect(res.status).toBe(401);
  });

  it('validates the login body', async () => {
    const res = await request(createApp()).post('/api/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('rate-limits login to 5 requests per minute per IP', async () => {
    const fresh = createApp();
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await request(fresh).post('/api/auth/login').send({ email: 'nobody@test.local', password: 'x' });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('requires a token for /profile', async () => {
    expect((await request(app).get('/api/auth/profile')).status).toBe(401);
    expect((await request(app).get('/api/auth/profile').set(bearer('garbage'))).status).toBe(401);
  });

  it('rejects a token signed with another secret', async () => {
    const forged = jwt.sign({ role_key: 'SUPER_ADMIN' }, 'x'.repeat(64), { subject: String(admin.user.id) });
    expect((await request(app).get('/api/auth/profile').set(bearer(forged))).status).toBe(401);
  });

  it('returns the profile for a valid token', async () => {
    const res = await request(app).get('/api/auth/profile').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: admin.user.id, role_key: 'SUPER_ADMIN' });
    expect(res.body.data.password_hash).toBeUndefined();
  });

  it('rejects tokens of users deactivated after issue', async () => {
    const u = await createUser('ZONE_ADMIN', { zone_id: null });
    await pool.query("UPDATE users SET status = 'INACTIVE' WHERE id = $1", [u.user.id]);
    expect((await request(app).get('/api/auth/profile').set(bearer(u.token))).status).toBe(401);
  });

  it('logs out (stateless) and audits the event', async () => {
    const res = await request(app).post('/api/auth/logout').set(bearer(admin.token));
    expect(res.status).toBe(200);
    const log = await pool.query("SELECT 1 FROM activity_logs WHERE action = 'LOGOUT' AND user_id = $1", [admin.user.id]);
    expect(log.rowCount).toBe(1);
  });

  it('returns 404 JSON for unknown routes', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
