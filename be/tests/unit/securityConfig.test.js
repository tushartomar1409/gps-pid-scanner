// GUIDE #11 C2/C5/C6: production env refusals, password policy, log redaction + scrubbing.
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { parseEnv } from '../../src/config/env.js';
import { passwordProblems } from '../../src/services/passwordPolicy.js';
import { REDACT_PATHS, scrubSecrets } from '../../src/utils/logger.js';

const PROD = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db.example.internal/app',
  JWT_SECRET: 'a3f1c9e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0',
  GPS_PROVIDER: 'acme',
  CORS_ORIGIN: 'https://portal.mcf.example.in',
  TRUST_PROXY: 'true',
};

describe('production env validation (C5)', () => {
  it('a safe production config parses', () => {
    expect(parseEnv(PROD)).toMatchObject({ NODE_ENV: 'production', GPS_PROVIDER: 'acme', TRUST_PROXY: true });
  });

  it.each([
    ['short JWT secret', { JWT_SECRET: 'x'.repeat(31) }, /JWT_SECRET must be at least 32/],
    ['.env.example placeholder (too short and a placeholder)', { JWT_SECRET: '<generate-a-64-char-hex-secret>' }, /JWT_SECRET/],
    ['long placeholder', { JWT_SECRET: '<generate-a-64-char-hex-secret-for-production>' }, /placeholder/],
    ['"changeme" style secret', { JWT_SECRET: 'changeme-changeme-changeme-changeme-1' }, /placeholder/],
    ['simulator provider', { GPS_PROVIDER: 'simulator' }, /simulator is not allowed/],
    ['wildcard CORS', { CORS_ORIGIN: '*' }, /wildcard/],
    ['localhost CORS', { CORS_ORIGIN: 'https://portal.mcf.example.in,http://localhost:5173' }, /localhost/],
    ['127.0.0.1 CORS', { CORS_ORIGIN: 'http://127.0.0.1:8080' }, /localhost/],
    ['TRUST_PROXY missing', { TRUST_PROXY: undefined }, /TRUST_PROXY must be set/],
  ])('refuses: %s', (_name, patch, msg) => {
    const src = { ...PROD, ...patch };
    for (const [k, v] of Object.entries(src)) if (v === undefined) delete src[k];
    expect(() => parseEnv(src)).toThrow(msg);
  });

  it('the same values are fine outside production (dev/test)', () => {
    expect(() => parseEnv({ ...PROD, NODE_ENV: 'development', GPS_PROVIDER: 'simulator', CORS_ORIGIN: 'http://localhost:5173', TRUST_PROXY: undefined })).not.toThrow();
  });
});

describe('password policy (C2)', () => {
  it('length, letter+digit, not the email, not common', () => {
    expect(passwordProblems('Shorty1', 'a@b.in')).toContain('Password must be at least 10 characters');
    expect(passwordProblems('onlyletterss', 'a@b.in')).toContain('Password must contain a letter and a digit');
    expect(passwordProblems('ravi.kumar@mcf.in', 'ravi.kumar@mcf.in').join()).toMatch(/not be your email/);
    expect(passwordProblems('Ravi.Kumar1', 'ravi.kumar1@mcf.in').join()).toMatch(/not be your email/); // local part
    expect(passwordProblems('Password123', 'x@y.in').join()).toMatch(/too common/);
    expect(passwordProblems('Kachra-Gaadi-2031', 'x@y.in')).toEqual([]);
  });
});

describe('logging (C6)', () => {
  it('redacts secret fields and scrubs connection strings anywhere in a log line', () => {
    const lines = [];
    const sink = new Writable({ write(c, _e, cb) { lines.push(JSON.parse(c)); cb(); } });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, sink);
    log.info({ req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1' } }, body: { password: 'p', token: 't', api_key: 'k' }, secret: 's' }, 'x');
    const l = lines[0];
    expect(l.req.headers).toEqual({ authorization: '[REDACTED]', cookie: '[REDACTED]' });
    expect(l.body).toEqual({ password: '[REDACTED]', token: '[REDACTED]', api_key: '[REDACTED]' });
    expect(l.secret).toBe('[REDACTED]');
    expect(scrubSecrets('connect failed: postgresql://neondb_owner:npg_XYZ@ep-x.neon.tech/db?sslmode=require (timeout)'))
      .toBe('connect failed: postgresql://[REDACTED] (timeout)');
  });
});
