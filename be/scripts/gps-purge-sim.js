// npm run gps:purge-sim [-- --confirm]
// Removes GPS demo data written by the SIMULATOR provider (provider = 'simulator') from the database in
// DATABASE_URL / DB_SCHEMA. Without --confirm it only prints what would be deleted (dry run).
// Real-provider data is never touched. Pre-created PID daily statuses are left as they are; PID visit
// events that reference simulator points (Phase 4+) are deleted with them.
import { withTransaction, closePool } from '../src/config/database.js';

const CONFIRM = process.argv.includes('--confirm');
const P = 'simulator';

try {
  const counts = await withTransaction(async (tx) => {
    const q = async (sql) => (await tx.query(sql, [P])).rowCount;
    const c = {
      pid_visit_events: await q(`DELETE FROM pid_visit_events WHERE gps_location_id IN (SELECT id FROM gps_locations WHERE provider = $1)`),
      vehicle_latest_locations: await q('DELETE FROM vehicle_latest_locations WHERE provider = $1'),
      gps_locations: await q('DELETE FROM gps_locations WHERE provider = $1'),
      gps_poll_runs: await q('DELETE FROM gps_poll_runs WHERE provider = $1'),
    };
    if (!CONFIRM) throw Object.assign(new Error('dry-run'), { dryRun: true, counts: c }); // roll back
    return c;
  }).catch((err) => {
    if (err.dryRun) return { ...err.counts, dryRun: true };
    throw err;
  });

  const { dryRun, ...c } = counts;
  console.log(`${dryRun ? 'DRY RUN — would delete' : 'Deleted'} simulator data:`);
  for (const [t, n] of Object.entries(c)) console.log(`  ${t.padEnd(26)} ${n}`);
  if (dryRun) console.log('\nRe-run with  npm run gps:purge-sim -- --confirm  to delete.');
} catch (err) {
  console.error('Purge failed:', err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
