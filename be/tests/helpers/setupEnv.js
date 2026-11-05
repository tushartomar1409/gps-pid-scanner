// Runs in each test worker BEFORE test files import src/ (env.js reads process.env on first import).
import os from 'node:os';
import path from 'node:path';
import { inject, afterAll } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DB_SCHEMA = inject('testSchema');
process.env.BCRYPT_ROUNDS = '4'; // speed only; production default stays 12
process.env.DB_POOL_MAX = '5';
// Report archive files go to a per-run temp dir (removed by globalSetup teardown), never be/storage.
process.env.REPORTS_DIR = path.join(os.tmpdir(), `gpspid-reports-${process.env.DB_SCHEMA}`);

afterAll(async () => {
  const { closePool } = await import('../../src/config/database.js');
  await closePool().catch(() => {});
});
