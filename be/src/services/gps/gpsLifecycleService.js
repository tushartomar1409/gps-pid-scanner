// GPS data lifecycle (GUIDE #11 A, workflow-docs/gps-data-lifecycle.md).
// - keeps monthly partitions of gps_locations pre-created (current IST month + 2 ahead)
// - retention: drops WHOLE partitions whose range ended more than gps.retention_days ago (never row DELETEs)
// - alerts when rows land in gps_locations_default (a month without a partition)
// Runs on one instance at a time: a transaction-scoped advisory lock (safe through the Neon pooler).
import { env } from '../../config/env.js';
import { pool, db as defaultDb } from '../../config/database.js';
import { logger as defaultLogger } from '../../utils/logger.js';
import { todayInTz } from '../../utils/time.js';
import { getSetting } from '../settingsService.js';
import { conflict } from '../../utils/errors.js';

export const MONTHS_AHEAD = 2;

/** Partition list with bounds, row estimates and sizes. */
export async function listPartitions(db = defaultDb) {
  const { rows } = await db.query('SELECT name, is_default, range_from, range_to, est_rows, total_bytes FROM gps_partitions()');
  return rows;
}

/** Start of the oldest retained monthly partition (raw GPS before this is gone), or null. */
export async function retainedFrom(db = defaultDb) {
  const { rows: [r] } = await db.query('SELECT min(range_from) AS t FROM gps_partitions() WHERE NOT is_default');
  return r?.t ?? null;
}

/** Throws 409 when an assignment window starts before the retained raw GPS (reprocess would erase evidence). */
export async function assertRawGpsRetained(windowStart, label, db = defaultDb) {
  const from = await retainedFrom(db);
  if (from && new Date(windowStart) < new Date(from)) {
    throw conflict(`Raw GPS no longer retained for ${label} (raw GPS is kept from ${new Date(from).toISOString()}); `
      + 'reprocessing would delete its visit evidence without being able to rebuild it');
  }
}

export async function defaultPartitionRows(db = defaultDb) {
  const { rows: [r] } = await db.query('SELECT count(*)::int AS n FROM (SELECT 1 FROM gps_locations_default LIMIT 100001) x');
  return r.n;
}

/**
 * One lifecycle pass. Returns { status, created, dropped, cutoff, default_rows, alerts }.
 * `now`, `retentionDays`, `monthsAhead` injectable for tests.
 */
export async function runGpsLifecycle({ now = new Date(), retentionDays, monthsAhead = MONTHS_AHEAD, logger = defaultLogger, tz = env.APP_TIMEZONE } = {}) {
  const days = retentionDays ?? (Number(await getSetting('gps.retention_days', 180)) || 180);
  const client = await pool.connect();
  const alerts = [];
  try {
    await client.query('BEGIN');
    const { rows: [l] } = await client.query("SELECT pg_try_advisory_xact_lock(hashtext('gps_lifecycle:' || current_schema())) AS ok");
    if (!l.ok) {
      await client.query('ROLLBACK');
      return { status: 'locked' };
    }
    const month = todayInTz(tz, now);
    let created = [];
    try {
      await client.query('SAVEPOINT ensure');
      created = (await client.query('SELECT gps_ensure_partitions($1::date, $2, $3) AS name', [month, monthsAhead + 1, tz])).rows.map((r) => r.name);
      await client.query('RELEASE SAVEPOINT ensure');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT ensure');
      alerts.push(`Could not pre-create partitions: ${err.message}`);
      logger.error({ err }, 'GPS partition pre-creation failed (rows for that month already in DEFAULT?)');
    }
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const dropped = (await client.query('SELECT gps_drop_partitions_before($1) AS name', [cutoff])).rows.map((r) => r.name);
    await client.query('COMMIT');

    const defaultRows = await defaultPartitionRows();
    if (defaultRows > 0) {
      alerts.push(`${defaultRows} GPS rows in gps_locations_default (no monthly partition for their recorded_at)`);
      logger.error({ default_rows: defaultRows }, 'ALERT: GPS rows landed in the DEFAULT partition');
    }
    if (created.length) logger.info({ created }, 'GPS partitions created');
    if (dropped.length) logger.info({ dropped, cutoff }, 'GPS partitions dropped by retention');
    lastRun = { at: new Date().toISOString(), created, dropped, cutoff: cutoff.toISOString(), default_rows: defaultRows, alerts };
    return { status: 'done', ...lastRun };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

let lastRun = null;
export const lastLifecycleRun = () => lastRun;

/** Scheduler: once at start, then every `everyMs` (default 6 h). */
export function startGpsLifecycle({ everyMs = 6 * 3600_000, logger = defaultLogger } = {}) {
  let timer = null;
  let stopped = false;
  let running = null;
  const tick = async () => {
    running = runGpsLifecycle({ logger }).catch((err) => logger.error({ err }, 'GPS lifecycle run failed'));
    await running;
    running = null;
    if (!stopped) {
      timer = setTimeout(tick, everyMs);
      timer.unref?.();
    }
  };
  timer = setTimeout(tick, 2_000);
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
