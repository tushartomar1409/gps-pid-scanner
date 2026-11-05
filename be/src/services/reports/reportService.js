// Report preview + streaming export (GUIDE #10 A/B).
// Rows are read with a server-side cursor (pg-query-stream) inside a READ ONLY transaction — transaction-
// scoped, so it also works through the Neon pooler — and piped straight into the writer.
import fs from 'node:fs';
import path from 'node:path';
import QueryStream from 'pg-query-stream';
import { env } from '../../config/env.js';
import { pool, db as defaultDb } from '../../config/database.js';
import { paginationMeta } from '../../utils/sql.js';
import { badRequest, unprocessable } from '../../utils/errors.js';
import { daysBetween, todayInTz } from '../../utils/time.js';
import { loadDetectionSettings } from '../settingsDefinitions.js';
import { recordActivity } from '../activityLogService.js';
import { GPS_DISCLAIMER } from '../dashboardService.js';
import { REPORTS, TRACK_CAP, orderedSql } from './definitions.js';
import { MISSED_REASON_ORDER, visitStatusLabel } from './labels.js';
import { createWriter, CONTENT_TYPES } from './writers.js';
import { exportFilename, istDateTime, scopeLabel } from './format.js';

export const PDF_MAX_ROWS = 5000;
export const MAX_RANGE_DAYS = 31;
export const STATEMENT_TIMEOUT_MS = 60_000;

/** date | from+to (≤ 31 days) -> q.from / q.to. Defaults to today (IST). */
export function resolveRange(q, tz = env.APP_TIMEZONE) {
  let from = q.from;
  let to = q.to;
  if (q.date) from = to = q.date;
  else if (!from && !to) from = to = todayInTz(tz);
  else if (!from || !to) throw badRequest('Give both `from` and `to`, or a single `date`');
  if (to < from) throw badRequest('`to` must be on or after `from`');
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw badRequest(`Date range may span at most ${MAX_RANGE_DAYS} days`);
  return { ...q, from, to };
}

/** vehicle-tracking window: date + HH:mm start/end in IST, ≤ 24 h. */
export function resolveTrackWindow(q) {
  const date = q.date || todayInTz(env.APP_TIMEZONE);
  const from = new Date(`${date}T${q.start || '00:00'}:00+05:30`);
  const to = new Date(`${date}T${q.end || '23:59'}:59.999+05:30`);
  if (!(to > from)) throw badRequest('`end` must be after `start`');
  return { ...q, from: date, to: date, window_from: from, window_to: to };
}

function sortCheck(def, q) {
  if (q.sort && !(q.sort in def.sortable)) {
    throw badRequest(`Unknown sort column "${q.sort}"`, [{ field: 'sort', message: `Allowed: ${Object.keys(def.sortable).join(', ')}` }]);
  }
}

export function prepare(name, rawQuery) {
  const def = REPORTS[name];
  const q = def.name === 'vehicle-tracking' ? resolveTrackWindow(rawQuery) : resolveRange(rawQuery);
  sortCheck(def, q);
  return { def, q };
}

export async function countRows(def, q, scope, db = defaultDb) {
  const b = def.build(q, scope);
  return Number((await db.query(`SELECT count(*)::int AS n FROM (${b.text}) t`, b.values)).rows[0].n);
}

export async function preview(name, rawQuery, scope, db = defaultDb) {
  const { def, q } = prepare(name, rawQuery);
  const b = def.build(q, scope);
  const sql = orderedSql(def, b, q.sort, q.dir);
  const lim = b.values.length + 1;
  const [count, page, extra] = await Promise.all([
    db.query(`SELECT count(*)::int AS n FROM (${b.text}) t`, b.values),
    db.query(`${sql} LIMIT $${lim} OFFSET $${lim + 1}`, [...b.values, q.limit, (q.page - 1) * q.limit]),
    def.name === 'missed-pids' ? reasonCounts(def, q, scope, db) : null,
  ]);
  return {
    report: def.name, title: def.title, from: q.from, to: q.to,
    columns: def.columns.map(({ key, header, type }) => ({ key, header, type })),
    sortable: Object.keys(def.sortable), sort: q.sort || def.defaultSort[0], dir: q.dir || def.defaultSort[1],
    rows: page.rows.map(def.record),
    pagination: paginationMeta(q.page, q.limit, count.rows[0].n),
    ...(extra ? { reason_counts: extra } : {}),
    disclaimer: GPS_DISCLAIMER,
  };
}

/** Missed-PID chips: counts per reason under the same filters (ignoring the reason filter). */
async function reasonCounts(def, q, scope, db) {
  const b = def.build(q, scope, { ignoreStatus: true });
  const { rows } = await db.query(`SELECT visit_status, count(*)::int AS n FROM (${b.text}) t GROUP BY visit_status`, b.values);
  const m = Object.fromEntries(rows.map((r) => [r.visit_status, r.n]));
  return MISSED_REASON_ORDER.map((k) => ({ reason: k, label: visitStatusLabel(k), count: m[k] || 0 }));
}

/** Streams the ordered report rows to onRow(record); returns the row count. */
// batchSize: rows per cursor fetch. Each fetch is one DB round trip (~265 ms to Neon from here), so 5,000 keeps
// a 100k-row export at ~20 round trips while bounding the rows held in memory.
export async function streamRows(def, q, scope, onRow, { batchSize = 5000 } = {}) {
  const b = def.build(q, scope);
  const client = await pool.connect();
  let failed = null;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const stream = client.query(new QueryStream(orderedSql(def, b, q.sort, q.dir), b.values, { batchSize }));
    let n = 0;
    try {
      for await (const row of stream) {
        await onRow(def.record(row));
        n++;
      }
    } catch (err) {
      stream.destroy();
      throw err;
    }
    await client.query('COMMIT');
    return n;
  } catch (err) {
    failed = err;
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release(failed ? true : undefined); // a broken connection is discarded, not reused
  }
}

const FILTER_LABELS = { zone_id: 'Zone id', ward_id: 'Ward id', agency_id: 'Agency id', vehicle_id: 'Vehicle id', route_id: 'Route id', status: 'Status' };
export function filterText(def, q) {
  const parts = [def.name === 'vehicle-tracking'
    ? `Date ${q.from} ${q.start || '00:00'}–${q.end || '23:59'} IST`
    : q.from === q.to ? `Date ${q.from}` : `Dates ${q.from} to ${q.to}`];
  for (const [k, label] of Object.entries(FILTER_LABELS)) if (q[k]) parts.push(`${label}: ${q[k]}`);
  return parts.join(' · ');
}

export async function buildMeta(def, q, scope, user, db = defaultDb) {
  const s = await loadDetectionSettings(db);
  const now = new Date();
  const scopeText = scope?.unrestricted ? 'All zones' : scopeLabel(scope);
  return {
    generatedAt: now, generatedAtText: istDateTime(now), generatedBy: user ? `${user.name} (${user.email})` : 'system (daily archive)',
    scopeText, filterText: filterText(def, q), disclaimer: GPS_DISCLAIMER,
    about: (rowCount) => [
      ['Report', `${def.title} (flow ${def.flow})`], ['Filters', filterText(def, q)], ['Generated at (IST)', istDateTime(now)],
      ['Generated by', user ? `${user.name} (${user.email})` : 'system (daily archive)'], ['Scope', scopeText], ['Row count', rowCount],
      ['Timezone', env.APP_TIMEZONE],
      ['Detection radius (m)', s.radiusM], ['Confirmation mode', s.confirmationMode], ['Consecutive points', s.consecutivePoints],
      ['Segment evidence', s.segmentEvidenceEnabled ? 'on' : 'off'],
      ['Disclaimer', GPS_DISCLAIMER],
    ],
  };
}

/** Writes the whole report to `out` in `format`; returns the row count. */
export async function writeReport(def, q, scope, format, out, meta) {
  const writer = createWriter(format, out, def, meta);
  const n = await streamRows(def, q, scope, (rec) => writer.row(rec));
  await writer.finish(meta.about(n));
  return n;
}

/** Pre-stream checks: format allowed, PDF ≤ 5,000 rows, track ≤ 50,000 points. Throws 4xx BEFORE any byte. */
export async function precheck(def, q, scope, format, db = defaultDb) {
  if (def.formats && !def.formats.includes(format)) throw badRequest(`${def.title} can be exported as ${def.formats.join(' or ')} only`);
  if (format === 'pdf') {
    const n = await countRows(def, q, scope, db);
    if (n > PDF_MAX_ROWS) throw unprocessable(`Too many rows for PDF (${n.toLocaleString('en-IN')} > ${PDF_MAX_ROWS.toLocaleString('en-IN')}); use Excel`);
  }
  if (def.name === 'vehicle-tracking') {
    const n = await countRows(def, q, scope, db);
    if (n > TRACK_CAP) throw unprocessable(`Too many GPS points (${n.toLocaleString('en-IN')} > ${TRACK_CAP.toLocaleString('en-IN')}); choose a shorter time window`);
  }
}

/** HTTP export. Headers are only sent after the prechecks; a mid-stream failure destroys the socket. */
export async function exportToResponse(name, rawQuery, format, req, res) {
  const { def, q } = prepare(name, rawQuery);
  await precheck(def, q, req.scope, format);
  const meta = await buildMeta(def, q, req.scope, req.user);
  const filename = exportFilename(def.name, q, scopeLabel(req.scope), format);
  res.status(200);
  res.setHeader('Content-Type', CONTENT_TYPES[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  let rows;
  try {
    rows = await writeReport(def, q, req.scope, format, res, meta);
  } catch (err) {
    // Never let a truncated file look complete: abort the connection (no terminating chunk).
    req.log?.error({ err, report: def.name, format }, 'Report export failed mid-stream');
    res.destroy(err);
    return;
  }
  await recordActivity({ user: req.user, ip: req.ip }, {
    action: 'EXPORT', module: 'reports', referenceId: def.name,
    details: { report: def.name, format, filters: publicFilters(q), row_count: rows },
  }).catch((err) => req.log?.warn({ err }, 'Export audit row failed'));
}

const publicFilters = (q) => Object.fromEntries(Object.entries(q).filter(([k, v]) => v !== undefined && v !== '' && !['page', 'limit', 'window_from', 'window_to', 'format'].includes(k))
  .map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));

/** Archive: write to <file>.partial, then rename (never leaves a truncated file under the final name). */
export async function writeReportFile(name, rawQuery, scope, format, absPath) {
  const { def, q } = prepare(name, rawQuery);
  const meta = await buildMeta(def, q, scope, null);
  await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.partial`;
  const out = fs.createWriteStream(tmp);
  try {
    const rows = await writeReport(def, q, scope, format, out, meta);
    await new Promise((resolve, reject) => (out.writableFinished ? resolve() : out.once('finish', resolve).once('error', reject)));
    await fs.promises.rename(tmp, absPath);
    const { size } = await fs.promises.stat(absPath);
    return { rows, size };
  } catch (err) {
    out.destroy();
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
