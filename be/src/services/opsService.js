// Ops / health (GUIDE #11 E). Background jobs register a status function here (index.js); the API never
// imports job internals.
import fs from 'node:fs/promises';
import { db as defaultDb } from '../config/database.js';
import { env } from '../config/env.js';
import { MIGRATIONS_DIR } from '../db/migrator.js';
import { listPartitions, defaultPartitionRows, lastLifecycleRun, retainedFrom } from './gps/gpsLifecycleService.js';
import { providerStatus } from './gps/gpsReadService.js';
import { lastArchiveRun } from './reports/archiveService.js';

const jobs = new Map();
/** registerJob('detection', () => ({ running, leader, ... })) */
export function registerJob(name, statusFn) {
  jobs.set(name, statusFn);
}
export function jobStatuses() {
  const out = {};
  for (const [name, fn] of jobs) {
    try {
      out[name] = fn();
    } catch (err) {
      out[name] = { error: err.message };
    }
  }
  return out;
}

/** Migration files on disk not yet recorded in schema_migrations. */
export async function pendingMigrations(db = defaultDb) {
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const { rows } = await db.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  return files.filter((f) => !applied.has(f));
}

/** Readiness: DB reachable + migrations up to date. */
export async function readiness(db = defaultDb) {
  const checks = { database: 'down', migrations: 'unknown' };
  let pending = [];
  try {
    await db.query('SELECT 1');
    checks.database = 'up';
    pending = await pendingMigrations(db);
    checks.migrations = pending.length ? 'pending' : 'up_to_date';
  } catch (err) {
    checks.error = err.code || 'DB_UNREACHABLE';
  }
  return { ready: checks.database === 'up' && checks.migrations === 'up_to_date', checks, pending_migrations: pending };
}

/** SUPER_ADMIN details: jobs/leaders, detection lag, last poll, archive, partitions. */
export async function details(db = defaultDb) {
  const [lag, poll, partitions, defaultRows, retained, archiveRows] = await Promise.all([
    // capped count: the partial unprocessed index keeps this cheap, the cap keeps it bounded under a backlog
    db.query(`SELECT (SELECT min(recorded_at) FROM gps_locations WHERE processed_at IS NULL) AS oldest_unprocessed_at,
                     (SELECT count(*) FROM (SELECT 1 FROM gps_locations WHERE processed_at IS NULL LIMIT 100001) x)::int AS unprocessed`),
    providerStatus(env.GPS_PROVIDER, { executor: db }),
    listPartitions(db),
    defaultPartitionRows(db),
    retainedFrom(db),
    db.query(`SELECT report_type, operational_date::text AS operational_date, status, finalized, finished_at
                FROM report_runs ORDER BY operational_date DESC, report_type LIMIT 10`),
  ]);
  const l = lag.rows[0];
  const lagSeconds = l.oldest_unprocessed_at ? Math.max(0, Math.round((Date.now() - new Date(l.oldest_unprocessed_at).getTime()) / 1000)) : 0;
  return {
    generated_at: new Date().toISOString(),
    jobs: jobStatuses(),
    detection: { lag_seconds: lagSeconds, oldest_unprocessed_at: l.oldest_unprocessed_at, unprocessed_points: l.unprocessed, unprocessed_capped: l.unprocessed > 100000 },
    gps_poll: { provider: poll.provider, state: poll.state, reason: poll.reason, last_success_at: poll.last_success_at, last_run: poll.last_run },
    archive: { last_run: lastArchiveRun(), recent: archiveRows.rows },
    gps_partitions: {
      retained_from: retained,
      default_rows: defaultRows,
      alert: defaultRows > 0 ? `${defaultRows} rows in gps_locations_default` : null,
      last_lifecycle_run: lastLifecycleRun(),
      partitions: partitions.map((p) => ({ name: p.name, is_default: p.is_default, range_from: p.range_from, range_to: p.range_to, est_rows: p.est_rows, total_bytes: Number(p.total_bytes) })),
    },
  };
}
