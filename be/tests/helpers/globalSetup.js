// Creates an isolated schema test_<random>, runs all migrations into it, and drops it after the run.
// The real (public) schema is never touched.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { buildConnectionConfig, closePool } from '../../src/config/database.js';
import { runMigrations } from '../../src/db/migrator.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GUIDE #11 B2: retry ONLY the connection step (Neon cold start / transient connect timeout), 3 attempts
 * with jittered backoff. Queries and migrations are never retried, so a real failure still fails loudly.
 * The connected client is released back to the pool, which then reuses it for the next query.
 */
export async function connectWithRetry(pool, { attempts = 3, baseMs = 1500, log = console.warn } = {}) {
  /* eslint-disable no-await-in-loop -- sequential retries by design */
  for (let i = 1; ; i++) {
    try {
      const c = await pool.connect();
      c.release();
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      const wait = baseMs * 2 ** (i - 1) + Math.floor(Math.random() * 500);
      log(`[globalSetup] DB connect attempt ${i}/${attempts} failed (${err.message}); retrying in ${wait} ms`);
      await sleep(wait);
    }
  }
}

export default async function setup({ provide }) {
  const schema = `test_${crypto.randomBytes(5).toString('hex')}`;
  const cfg = (o) => ({ ...buildConnectionConfig(o), connectionTimeoutMillis: 30_000 });

  const admin = new pg.Pool(cfg({ schema: undefined }));
  await connectWithRetry(admin);
  await admin.query(`CREATE SCHEMA ${schema}`);

  const scoped = new pg.Pool(cfg({ schema }));
  await connectWithRetry(scoped);
  await runMigrations(scoped);
  await scoped.end();
  await closePool(); // default pool created on import; unused here

  provide('testSchema', schema);

  return async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    fs.rmSync(path.join(os.tmpdir(), `gpspid-reports-${schema}`), { recursive: true, force: true });
    await admin.end();
  };
}
