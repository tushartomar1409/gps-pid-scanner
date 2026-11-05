// Plain numbered-SQL migration runner. Each file runs in its own transaction and is recorded
// in schema_migrations (created in the current search_path schema).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function runMigrations(pool, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const client = await pool.connect();
  let locked = false;
  try {
    // Serialise concurrent runners (lock is per-database; fine for a short critical section).
    await client.query("SELECT pg_advisory_lock(hashtext('schema_migrations'))");
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    const files = (await fs.readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const ran = [];
    for (const file of files) {
      if (applied.has(file)) {
        log(`skip   ${file} (already applied)`);
        continue;
      }
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        err.message = `Migration ${file} failed: ${err.message}`;
        throw err;
      }
      ran.push(file);
      log(`apply  ${file}`);
    }
    return ran;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('schema_migrations'))").catch(() => {});
    client.release();
  }
}
