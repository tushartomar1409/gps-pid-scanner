// Automatic daily reports (GUIDE #10 C, flow §23 step 10).
//
// Once per day (≥ REPORTS_DAILY_TIME IST) for the PREVIOUS operational day:
//   - wait until every assignment of that day is finalized; until REPORTS_WAIT_UNTIL retry hourly,
//     then generate anyway and mark the runs finalized=false
//   - XLSX for daily-coverage, vehicle-wise, ward-wise, agency-wise, missed-pids, scope = all
//   - files under REPORTS_DIR/YYYY/MM/, written to *.partial then renamed (atomic)
//   - idempotent: a (type, day, format) with a SUCCESS row is never generated again
//   - retention: runs + files older than REPORTS_RETENTION_DAYS are deleted
// Leader: a transaction-level advisory lock held for the whole run (safe through the Neon pooler, which
// pins the connection for a transaction). On several servers REPORTS_DIR must be SHARED storage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../config/env.js';
import { pool, db as defaultDb } from '../../config/database.js';
import { logger as defaultLogger } from '../../utils/logger.js';
import { paginationMeta } from '../../utils/sql.js';
import { notFound } from '../../utils/errors.js';
import { addDays, todayInTz } from '../../utils/time.js';
import { writeReportFile } from './reportService.js';

export const ARCHIVE_TYPES = ['daily-coverage', 'vehicle-wise', 'ward-wise', 'agency-wise', 'missed-pids'];
const BE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const reportsDir = (dir = env.REPORTS_DIR) => path.resolve(BE_ROOT, dir);

/** Resolve a stored relative path and assert it stays under the reports dir (path-traversal guard). */
export function safeArchivePath(rel, dir = reportsDir()) {
  const root = path.resolve(dir);
  const abs = path.resolve(root, String(rel ?? ''));
  if (!rel || path.isAbsolute(String(rel)) || (abs !== root && !abs.startsWith(root + path.sep)) || abs === root) return null;
  return abs;
}

const hhmm = (now, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);

/**
 * One archive pass. Returns { status: 'before_time'|'up_to_date'|'waiting'|'locked'|'done', ... }.
 * Options are injectable for tests (now, dir, waitUntil, dailyTime, retentionDays).
 */
export async function runDailyArchive({
  now = new Date(), dir = reportsDir(), db = defaultDb, logger = defaultLogger,
  dailyTime = env.REPORTS_DAILY_TIME, waitUntil = env.REPORTS_WAIT_UNTIL, retentionDays = env.REPORTS_RETENTION_DAYS, tz = env.APP_TIMEZONE,
} = {}) {
  const today = todayInTz(tz, now);
  const time = hhmm(now, tz);
  if (time < dailyTime) return { status: 'before_time', time };
  const opDate = addDays(today, -1);

  const lockClient = await pool.connect();
  try {
    await lockClient.query('BEGIN');
    const { rows: [l] } = await lockClient.query("SELECT pg_try_advisory_xact_lock(hashtext('report_archive:' || current_schema())) AS ok");
    if (!l.ok) {
      await lockClient.query('ROLLBACK');
      return { status: 'locked' };
    }
    const retention = await applyRetention({ db, dir, today, retentionDays, logger });

    const { rows: done } = await db.query(
      "SELECT report_type FROM report_runs WHERE operational_date = $1 AND format = 'xlsx' AND status = 'SUCCESS'", [opDate]);
    const todo = ARCHIVE_TYPES.filter((t) => !done.some((d) => d.report_type === t));
    if (!todo.length) {
      await lockClient.query('COMMIT');
      return { status: 'up_to_date', operational_date: opDate, retention };
    }

    const { rows: [o] } = await db.query(
      "SELECT count(*)::int AS open FROM route_assignments WHERE operational_date = $1 AND finalized_at IS NULL AND status IN ('PLANNED', 'ACTIVE')", [opDate]);
    if (o.open > 0 && time < waitUntil) {
      await lockClient.query('COMMIT');
      return { status: 'waiting', operational_date: opDate, open_assignments: o.open, retry_until: waitUntil, retention };
    }
    const finalized = o.open === 0;

    const results = [];
    /* eslint-disable no-await-in-loop -- one report at a time: bounded memory and DB load */
    for (const type of todo) {
      const rel = path.posix.join(opDate.slice(0, 4), opDate.slice(5, 7), `${type}_${opDate}.xlsx`);
      const { rows: [run] } = await db.query(
        "INSERT INTO report_runs (report_type, operational_date, format, file_path, status, finalized) VALUES ($1, $2, 'xlsx', $3, 'RUNNING', $4) RETURNING id",
        [type, opDate, rel, finalized]);
      try {
        const abs = safeArchivePath(rel, dir);
        const { rows, size } = await writeReportFile(type, { date: opDate }, { unrestricted: true }, 'xlsx', abs);
        await db.query("UPDATE report_runs SET status = 'SUCCESS', row_count = $2, size_bytes = $3, finished_at = now() WHERE id = $1", [run.id, rows, size]);
        results.push({ type, status: 'SUCCESS', rows, size });
      } catch (err) {
        logger.error({ err, type, opDate }, 'Daily report generation failed');
        await db.query("UPDATE report_runs SET status = 'FAILED', error = $2, finished_at = now() WHERE id = $1", [run.id, String(err.message).slice(0, 500)]);
        results.push({ type, status: 'FAILED', error: err.message });
      }
    }
    /* eslint-enable no-await-in-loop */
    await lockClient.query('COMMIT');
    if (!finalized) logger.warn({ opDate, open: o.open }, 'Daily reports generated before every assignment was finalized');
    return { status: 'done', operational_date: opDate, finalized, results, retention };
  } catch (err) {
    await lockClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    lockClient.release();
  }
}

async function applyRetention({ db, dir, today, retentionDays, logger }) {
  const cutoff = addDays(today, -retentionDays);
  const { rows } = await db.query('DELETE FROM report_runs WHERE operational_date < $1 RETURNING id, file_path', [cutoff]);
  let files = 0;
  for (const r of rows) {
    const abs = safeArchivePath(r.file_path, dir);
    if (!abs) continue;
    try {
      await fs.promises.rm(abs, { force: true }); // eslint-disable-line no-await-in-loop
      files++;
    } catch (err) {
      logger.warn({ err, file: r.file_path }, 'Retention: could not delete report file');
    }
  }
  return { cutoff, runs_deleted: rows.length, files_deleted: files };
}

/** GET /api/reports/archive */
export async function listArchive(q, db = defaultDb) {
  const values = [];
  const where = [];
  const p = (v) => { values.push(v); return `$${values.length}`; };
  if (q.from) where.push(`operational_date >= ${p(q.from)}::date`);
  if (q.to) where.push(`operational_date <= ${p(q.to)}::date`);
  if (q.type) where.push(`report_type = ${p(q.type)}`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.query(`SELECT count(*)::int AS n FROM report_runs ${w}`, values)).rows[0].n;
  const { rows } = await db.query(
    `SELECT id, report_type, operational_date::text AS operational_date, format, size_bytes, row_count, status, finalized, error, created_at, finished_at
       FROM report_runs ${w} ORDER BY operational_date DESC, report_type, id DESC LIMIT ${p(q.limit)} OFFSET ${p((q.page - 1) * q.limit)}`, values);
  return { rows, pagination: paginationMeta(q.page, q.limit, total) };
}

/** Resolves a SUCCESS run to { abs, filename } or throws 404 (missing row, bad path, missing file). */
export async function archiveFile(id, { db = defaultDb, dir = reportsDir() } = {}) {
  const { rows: [r] } = await db.query("SELECT id, report_type, operational_date::text AS d, format, file_path FROM report_runs WHERE id = $1 AND status = 'SUCCESS'", [id]);
  if (!r) throw notFound('Report file not found');
  const abs = safeArchivePath(r.file_path, dir);
  if (!abs) throw notFound('Report file not found');
  try {
    const st = await fs.promises.stat(abs);
    if (!st.isFile()) throw new Error('not a file');
    return { abs, size: st.size, filename: `${r.report_type}_${r.d}_all.${r.format}`, format: r.format };
  } catch {
    throw notFound('Report file not found');
  }
}

/** Leader-safe scheduler: checks every `tickMs`; after a "waiting" result it retries hourly. */
export function startReportArchive({ tickMs = 5 * 60_000, retryMs = 60 * 60_000, logger = defaultLogger } = {}) {
  let timer = null;
  let stopped = false;
  let nextAttemptAt = 0;
  let running = null;
  const tick = async () => {
    if (stopped) return;
    if (Date.now() >= nextAttemptAt) {
      running = runDailyArchive({ logger })
        .then((r) => {
          if (r.status === 'waiting') nextAttemptAt = Date.now() + retryMs;
          if (r.status === 'done') logger.info({ result: r }, 'Daily reports archived');
        })
        .catch((err) => logger.error({ err }, 'Daily report archive run failed'));
      await running;
      running = null;
    }
    if (!stopped) {
      timer = setTimeout(tick, tickMs);
      timer.unref?.();
    }
  };
  timer = setTimeout(tick, 5_000);
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
