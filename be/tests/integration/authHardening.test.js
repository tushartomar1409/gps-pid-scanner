// GUIDE #11 C2: per-account lockout, password policy on create/change, token_version revocation.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { authService, LOCKOUT } from '../../src/services/authService.js';
import { createUser, bearer, uid } from '../helpers/fixtures.js';

let app;
beforeAll(() => {
  app = createApp();
});
const ctx = { ip: '10.0.0.1' };
const login = (email, password) => authService.login({ email, password }, ctx).then(() => 'ok', (e) => e.message);

describe('per-account lockout', () => {
  it('10 failures in 15 min lock the account for 15 min, with the same generic message; audited', async () => {
    const u = await createUser('DEPARTMENT_ADMIN');
    for (let i = 0; i < LOCKOUT.maxFailures; i++) {
      expect(await login(u.user.email, 'wrong-Passw0rd')).toBe('Invalid email or password'); // eslint-disable-line no-await-in-loop
    }
    // the correct password is now refused too, with the SAME message (no enumeration)
    expect(await login(u.user.email, u.password)).toBe('Invalid email or password');
    const { rows: [s] } = await pool.query('SELECT failed_login_count, locked_until > now() + interval \'14 minutes\' AS locked_15 FROM users WHERE id = $1', [u.user.id]);
    expect(s).toEqual({ failed_login_count: 10, locked_15: true });
    const audit = (await pool.query("SELECT action, details FROM activity_logs WHERE reference_id = $1 AND module = 'auth' ORDER BY id", [String(u.user.id)])).rows;
    expect(audit.filter((a) => a.action === 'ACCOUNT_LOCKED')).toHaveLength(1);
    expect(audit.at(-1)).toMatchObject({ action: 'LOGIN_FAILED', details: { reason: 'ACCOUNT_LOCKED' } });

    // lock expires -> correct password works and resets the counter
    await pool.query("UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1", [u.user.id]);
    expect(await login(u.user.email, u.password)).toBe('ok');
    expect((await pool.query('SELECT failed_login_count, locked_until FROM users WHERE id = $1', [u.user.id])).rows[0]).toEqual({ failed_login_count: 0, locked_until: null });
  });

  it('failures older than the 15-min window start a new count', async () => {
    const u = await createUser('DEPARTMENT_ADMIN');
    await pool.query("UPDATE users SET failed_login_count = 9, failed_login_window_start = now() - interval '16 minutes' WHERE id = $1", [u.user.id]);
    await login(u.user.email, 'wrong-Passw0rd');
    expect((await pool.query('SELECT failed_login_count, locked_until FROM users WHERE id = $1', [u.user.id])).rows[0]).toEqual({ failed_login_count: 1, locked_until: null });
  });
});

describe('password policy on create / change', () => {
  it('rejects short, email-equal and common passwords with field errors', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const email = `policy.${uid().toLowerCase()}@test.local`;
    const base = { name: 'Policy', email, role_key: 'DEPARTMENT_ADMIN' };
    const short = await request(app).post('/api/users').set(bearer(admin.token)).send({ ...base, password: 'Abc12345' });
    expect(short.status).toBe(400);
    const same = await request(app).post('/api/users').set(bearer(admin.token)).send({ ...base, password: email });
    expect(same.status).toBe(400);
    expect(JSON.stringify(same.body.errors)).toMatch(/not be your email/);
    const common = await request(app).post('/api/users').set(bearer(admin.token)).send({ ...base, password: 'Password123' });
    expect(JSON.stringify(common.body.errors)).toMatch(/too common/);
    const ok = await request(app).post('/api/users').set(bearer(admin.token)).send({ ...base, password: 'Kachra-Gaadi-2031' });
    expect(ok.status).toBe(201);
    const change = await request(app).put(`/api/users/${ok.body.data.id}`).set(bearer(admin.token)).send({ password: 'Password1234' });
    expect(change.status).toBe(400);
  });
});

describe('token_version: revoke sessions', () => {
  it('log out all sessions invalidates every existing token (REST)', async () => {
    const u = await createUser('DEPARTMENT_ADMIN');
    const a = await request(app).post('/api/auth/login').send({ email: u.user.email, password: u.password });
    const t1 = a.body.data.token;
    expect((await request(app).get('/api/auth/profile').set(bearer(t1))).status).toBe(200);
    expect((await request(app).post('/api/auth/logout-all').set(bearer(t1))).status).toBe(200);
    const after = await request(app).get('/api/auth/profile').set(bearer(t1));
    expect(after.status).toBe(401);
    expect(after.body.message).toMatch(/Session ended/);
    const b = await request(app).post('/api/auth/login').send({ email: u.user.email, password: u.password });
    expect((await request(app).get('/api/auth/profile').set(bearer(b.body.data.token))).status).toBe(200); // new login works
    expect((await pool.query("SELECT count(*)::int n FROM activity_logs WHERE action = 'LOGOUT_ALL' AND user_id = $1", [u.user.id])).rows[0].n).toBe(1);
  });

  it('a password change by an admin or a deactivation revokes the user’s tokens', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const u = await createUser('DEPARTMENT_ADMIN');
    const t = (await request(app).post('/api/auth/login').send({ email: u.user.email, password: u.password })).body.data.token;
    expect((await request(app).put(`/api/users/${u.user.id}`).set(bearer(admin.token)).send({ name: 'Renamed only' })).status).toBe(200);
    expect((await request(app).get('/api/auth/profile').set(bearer(t))).status).toBe(200); // a non-password edit keeps sessions
    expect((await request(app).put(`/api/users/${u.user.id}`).set(bearer(admin.token)).send({ password: 'Fresh-Passw0rd-9' })).status).toBe(200);
    expect((await request(app).get('/api/auth/profile').set(bearer(t))).status).toBe(401);
  });
});
