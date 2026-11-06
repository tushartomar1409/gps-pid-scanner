// E2E global setup (GUIDE #11 D1): a throwaway e2e_<hex> schema (NEVER public), migrations, a seeded super
// admin, the backend (simulator, fast polling) and the production fe build under `vite preview` with the
// strict CSP. Test credentials are generated per run and kept only in e2e/.state/ (gitignored, removed on
// teardown).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const BE = path.join(ROOT, 'be');
const FE = path.join(ROOT, 'fe');
export const STATE_DIR = path.join(HERE, '.state');
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const API_PORT = 5055;
export const WEB_PORT = 4173;
export const API = `http://127.0.0.1:${API_PORT}`;
export const WEB = `http://127.0.0.1:${WEB_PORT}`;

const VITE = path.join(FE, 'node_modules', 'vite', 'bin', 'vite.js');
const log = (m) => console.log(`[e2e] ${m}`);

/** Runs a node snippet inside be/ (so be/.env and be/node_modules apply). */
function beNode(args, env = {}) {
  const r = spawnSync(process.execPath, args, { cwd: BE, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`be command failed (${args.join(' ').slice(0, 80)}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

export function dropSchema(schema) {
  if (!/^e2e_[a-f0-9]+$/.test(schema)) throw new Error(`refusing to drop ${schema}`);
  beNode(['--input-type=module', '-e', `
    import pg from 'pg'; import { buildConnectionConfig } from './src/config/database.js';
    const c = new pg.Client(buildConnectionConfig({ schema: undefined })); await c.connect();
    await c.query('DROP SCHEMA IF EXISTS ${schema} CASCADE'); await c.end();`]);
}

async function waitFor(url, ms = 90_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function api(method, p, token, body) {
  const r = await fetch(`${API}/api${p}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j.data;
}

const secret = () => `E2e-${crypto.randomBytes(9).toString('base64url')}-7`;

export default async function globalSetup() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const schema = `e2e_${crypto.randomBytes(5).toString('hex')}`;
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpspid-e2e-reports-'));
  const state = { schema, reportsDir, pids: [] };
  const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  save();

  log(`schema ${schema}`);
  beNode(['--input-type=module', '-e', `
    import pg from 'pg'; import { buildConnectionConfig } from './src/config/database.js';
    const c = new pg.Client(buildConnectionConfig({ schema: undefined })); await c.connect();
    await c.query('CREATE SCHEMA ${schema}'); await c.end();`]);
  beNode(['scripts/migrate.js'], { DB_SCHEMA: schema });
  state.admin = { email: 'e2e.admin@e2e.test', password: secret() };
  beNode(['scripts/seed-admin.js'], { DB_SCHEMA: schema, SUPER_ADMIN_EMAIL: state.admin.email, SUPER_ADMIN_PASSWORD: state.admin.password, SUPER_ADMIN_NAME: 'E2E Admin' });
  save();

  log('building fe (VITE_E2E=1)');
  const b = spawnSync(process.execPath, [VITE, 'build', '--logLevel', 'warn'], { cwd: FE, env: { ...process.env, VITE_E2E: '1' }, encoding: 'utf8' });
  if (b.status !== 0) throw new Error(`fe build failed: ${b.stderr}`);

  const beEnv = {
    ...process.env, DB_SCHEMA: schema, PORT: String(API_PORT), NODE_ENV: 'development', LOG_LEVEL: 'warn',
    GPS_PROVIDER: 'simulator', GPS_POLL_ENABLED: 'true', GPS_POLL_INTERVAL_SECONDS: '5', GPS_SIM_PLAN_REFRESH_POLLS: '1',
    GPS_SIM_SPEED_KMH: '20', GPS_SIM_JITTER_M: '5', DETECTION_CATCHUP_SECONDS: '5',
    CORS_ORIGIN: WEB, TRUST_PROXY: 'false', LOGIN_RATE_LIMIT_PER_MIN: '60', REPORTS_ARCHIVE_ENABLED: 'false', REPORTS_DIR: reportsDir,
  };
  const out = fs.openSync(path.join(STATE_DIR, 'be.log'), 'w');
  const be = spawn(process.execPath, ['src/index.js'], { cwd: BE, env: beEnv, stdio: ['ignore', out, out] });
  state.bePid = be.pid;
  const fout = fs.openSync(path.join(STATE_DIR, 'fe.log'), 'w');
  const fe = spawn(process.execPath, [VITE, 'preview', '--port', String(WEB_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: FE, env: { ...process.env, API_PROXY_TARGET: API, CSP: '1' }, stdio: ['ignore', fout, fout],
  });
  state.fePid = fe.pid;
  save();
  await waitFor(`${API}/api/health/ready`);
  await waitFor(WEB);
  log('servers up');

  // Master data the specs build on (the PID import itself is a spec).
  const t = (await api('POST', '/auth/login', null, state.admin)).token;
  const zone = await api('POST', '/zones', t, { zone_code: 'NIT', zone_name: 'NIT Faridabad' });
  const ward = await api('POST', '/wards', t, { zone_id: zone.id, ward_number: '12', ward_name: 'Ward 12' });
  const abc = await api('POST', '/agencies', t, { agency_name: 'ABC Agency' });
  const xyz = await api('POST', '/agencies', t, { agency_name: 'XYZ Agency' });
  const v1 = await api('POST', '/vehicles', t, { vehicle_number: 'HR38AB1234', vehicle_type: 'Tipper', gps_device_id: 'E2E-1234', agency_id: abc.id, zone_id: zone.id, ward_id: ward.id });
  const v2 = await api('POST', '/vehicles', t, { vehicle_number: 'HR38XY9999', vehicle_type: 'Tipper', gps_device_id: 'E2E-9999', agency_id: xyz.id, zone_id: zone.id, ward_id: ward.id });
  state.agencyUser = { email: 'e2e.agency@e2e.test', password: secret() };
  await api('POST', '/users', t, { name: 'ABC Supervisor', email: state.agencyUser.email, password: state.agencyUser.password, role_key: 'AGENCY_USER', agency_id: abc.id });
  Object.assign(state, { zone, ward, agencies: { abc, xyz }, vehicles: { v1, v2 } });
  save();
  log('seeded masters');
}
