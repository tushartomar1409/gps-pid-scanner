// Stops both servers and drops the e2e schema + temp files (state with the generated test passwords too).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { STATE_FILE, dropSchema } from './global-setup.js';

function kill(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

export default async function globalTeardown() {
  if (!fs.existsSync(STATE_FILE)) return;
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  kill(s.bePid);
  kill(s.fePid);
  await new Promise((r) => setTimeout(r, 1500)); // let the backend release its DB connections
  if (s.schema) dropSchema(s.schema);
  if (s.reportsDir) fs.rmSync(s.reportsDir, { recursive: true, force: true });
  if (!process.env.E2E_KEEP_STATE) fs.rmSync(STATE_FILE, { force: true });
  console.log(`[e2e] dropped ${s.schema}`);
}
