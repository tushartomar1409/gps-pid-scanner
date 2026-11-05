// npm run migrate — applies pending migrations/NNNN_*.sql to DATABASE_URL (or DB_SCHEMA if set).
import { pool, closePool } from '../src/config/database.js';
import { runMigrations } from '../src/db/migrator.js';

try {
  const ran = await runMigrations(pool, { log: (m) => console.log(m) });
  console.log(ran.length ? `Done: ${ran.length} migration(s) applied.` : 'Done: database is up to date.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
