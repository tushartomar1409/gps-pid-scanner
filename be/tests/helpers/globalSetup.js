// Creates an isolated schema test_<random>, runs all migrations into it, and drops it after the run.
// The real (public) schema is never touched.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { buildConnectionConfig, closePool } from '../../src/config/database.js';
import { runMigrations } from '../../src/db/migrator.js';

export default async function setup({ provide }) {
  const schema = `test_${crypto.randomBytes(5).toString('hex')}`;

  const admin = new pg.Pool(buildConnectionConfig({ schema: undefined }));
  await admin.query(`CREATE SCHEMA ${schema}`);

  const scoped = new pg.Pool(buildConnectionConfig({ schema }));
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
