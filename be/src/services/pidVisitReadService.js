// Read APIs over detection results (flow.txt §17 "PID Visits", GUIDE #7 G).
import { db as defaultDb } from '../config/database.js';
import { SqlWhere, paginationMeta } from '../utils/sql.js';
import { applyScope } from '../middleware/scopeMiddleware.js';
import { notFound, badRequest } from '../utils/errors.js';
import { PID_SCOPE } from '../repositories/pidRepository.js';
import { daysBetween } from '../utils/time.js';

const RA_SCOPE = { zone: 'r.zone_id', ward: 'r.ward_id', agency: 'ra.agency_id' };
/** Assignment + route + vehicle joins, attached to a driving table by `on`. */
const joinRa = (on) => `JOIN route_assignments ra ON ${on}
  JOIN routes r   ON r.id = ra.route_id
  JOIN vehicles v ON v.id = ra.vehicle_id`;

/** Human wording for evidence types (GUIDE #8: a segment is never presented as a point fix). */
export const EVIDENCE_LABELS = {
  PROXIMITY_POINT: 'GPS point within detection radius',
  TRACK_SEGMENT: 'Track passed nearby (between two GPS points)',
  REJECTED_SPEED: 'GPS point within radius, rejected (speed outside limits)',
  REJECTED_STALE: 'GPS point within radius, rejected (data too old when received)',
  CONSECUTIVE_CONFIRMED: 'Consecutive GPS points within radius',
};
const evidenceLabelSql = (col) => `CASE ${col} ${Object.entries(EVIDENCE_LABELS).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(' ')} END`;

export const MISSED_REASONS = {
  NOT_VISITED: 'No qualifying GPS point within the detection radius',
  GPS_VISIT_CANDIDATE: 'GPS proximity detected but confirmation conditions not met',
  GPS_DATA_UNAVAILABLE: 'Insufficient GPS data (no points in the window, or PID without coordinates)',
  UNASSIGNED_PID: 'PID not assigned to an active route',
};

async function page(db, select, from, where, orderBy, { page: p, limit }) {
  const whereSql = where.toSql();
  const total = (await db.query(`SELECT count(*) AS total FROM ${from} ${whereSql}`, where.params)).rows[0].total;
  const lp = where.param(limit);
  const op = where.param((p - 1) * limit);
  const { rows } = await db.query(`SELECT ${select} FROM ${from} ${whereSql} ORDER BY ${orderBy} LIMIT ${lp} OFFSET ${op}`, where.params);
  return { rows, pagination: paginationMeta(p, limit, total) };
}

export function listVisitEvents(q, scope, db = defaultDb) {
  const where = applyScope(new SqlWhere(), scope, RA_SCOPE).add('ra.operational_date = ?', q.date);
  where.eq('e.pid_id', q.pid_id);
  where.eq('e.vehicle_id', q.vehicle_id);
  where.eq('e.route_assignment_id', q.route_assignment_id);
  where.eq('e.evidence_status', q.evidence_status);
  if (q.ambiguous !== undefined) where.add('e.ambiguous = ?', q.ambiguous);
  return page(db,
    `e.id, e.route_assignment_id, e.pid_id, p.pid_number, e.vehicle_id, v.vehicle_number, r.route_code,
     e.gps_location_id, e.distance_meters, e.speed_at_detection, e.detected_at, e.evidence_status,
     ${evidenceLabelSql('e.evidence_status')} AS evidence_label, e.ambiguous, e.pids_in_radius`,
    `pid_visit_events e ${joinRa('ra.id = e.route_assignment_id')} JOIN pids p ON p.id = e.pid_id`,
    where, 'e.detected_at, e.id', q);
}

const GROUPS = {
  zone: { key: 'r.zone_id', label: 'z.zone_name', join: 'JOIN zones z ON z.id = r.zone_id' },
  ward: { key: 'r.ward_id', label: 'w.ward_name', join: 'JOIN wards w ON w.id = r.ward_id' },
  agency: { key: 'ra.agency_id', label: "COALESCE(a.agency_name, '(no agency)')", join: 'LEFT JOIN agencies a ON a.id = ra.agency_id' },
  vehicle: { key: 'ra.vehicle_id', label: 'v.vehicle_number', join: '' },
  route: { key: 'ra.route_id', label: 'r.route_code', join: '' },
};

/** Coverage per flow.txt §12: confirmed / assigned × 100, counting only PIDs assigned that day. */
export async function dailySummary(q, scope, db = defaultDb) {
  const g = GROUPS[q.group_by];
  const where = applyScope(new SqlWhere(), scope, RA_SCOPE)
    .add('ra.operational_date = ?', q.date).add("ra.status <> 'CANCELLED'");
  where.eq('r.zone_id', q.zone_id);
  where.eq('r.ward_id', q.ward_id);
  where.eq('ra.agency_id', q.agency_id);
  where.eq('ra.vehicle_id', q.vehicle_id);
  const { rows } = await db.query(
    `SELECT ${g.key} AS group_id, ${g.label} AS group_name,
            count(*)::int AS assigned,
            count(*) FILTER (WHERE s.visit_status = 'GPS_VISIT_CONFIRMED')::int  AS confirmed,
            count(*) FILTER (WHERE s.visit_status = 'GPS_VISIT_CANDIDATE')::int  AS candidate,
            count(*) FILTER (WHERE s.visit_status = 'NOT_VISITED')::int          AS not_visited,
            count(*) FILTER (WHERE s.visit_status = 'GPS_DATA_UNAVAILABLE')::int AS unavailable,
            round(100.0 * count(*) FILTER (WHERE s.visit_status = 'GPS_VISIT_CONFIRMED') / NULLIF(count(*), 0), 1)::float8 AS coverage_pct
       FROM pid_daily_status s
       ${joinRa('ra.id = s.route_assignment_id')}
       ${g.join}
      ${where.toSql()}
      GROUP BY ${g.key}, ${g.label}
      ORDER BY ${g.label}`,
    where.params);
  const t = rows.reduce((acc, r) => {
    for (const k of ['assigned', 'confirmed', 'candidate', 'not_visited', 'unavailable']) acc[k] += r[k];
    return acc;
  }, { assigned: 0, confirmed: 0, candidate: 0, not_visited: 0, unavailable: 0 });
  t.coverage_pct = t.assigned ? Math.round((1000 * t.confirmed) / t.assigned) / 10 : null;
  return { date: q.date, group_by: q.group_by, groups: rows, totals: t };
}

export function missedPids(q, scope, db = defaultDb) {
  const where = applyScope(new SqlWhere(), scope, RA_SCOPE)
    .add('ra.operational_date = ?', q.date).add("ra.status <> 'CANCELLED'").add("s.visit_status <> 'GPS_VISIT_CONFIRMED'");
  where.eq('r.zone_id', q.zone_id);
  where.eq('r.ward_id', q.ward_id);
  where.eq('ra.agency_id', q.agency_id);
  where.eq('ra.vehicle_id', q.vehicle_id);
  where.eq('ra.route_id', q.route_id);
  where.eq('s.visit_status', q.visit_status);
  return page(db,
    `s.route_assignment_id, s.pid_id, p.pid_number, p.address, r.route_code, v.vehicle_number, s.visit_status,
     s.first_visit_at, s.last_visit_at, s.detection_count, s.min_distance_meters, s.ambiguous,
     CASE s.visit_status ${Object.entries(MISSED_REASONS).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(' ')} END AS reason`,
    `pid_daily_status s ${joinRa('ra.id = s.route_assignment_id')} JOIN pids p ON p.id = s.pid_id`,
    where, 'r.route_code, p.pid_number', q);
}

export async function pidHistory(pidId, { from, to }, scope, db = defaultDb) {
  if (to < from) throw badRequest('`to` must be on or after `from`');
  if (daysBetween(from, to) > 30) throw badRequest('PID history may span at most 31 days');
  const vis = applyScope(new SqlWhere(), scope, PID_SCOPE).add('p.id = ?', pidId);
  const pid = (await db.query(`SELECT p.id, p.pid_number, p.address FROM pids p ${vis.toSql()}`, vis.params)).rows[0];
  if (!pid) throw notFound('PID not found');
  const where = applyScope(new SqlWhere(), scope, RA_SCOPE)
    .add('s.pid_id = ?', pidId).add('ra.operational_date BETWEEN ? AND ?', from, to);
  const { rows } = await db.query(
    `SELECT ra.operational_date::text AS operational_date, s.route_assignment_id, r.route_code, v.vehicle_number, s.visit_status,
            s.first_visit_at, s.last_visit_at, s.detection_count, s.min_distance_meters, s.ambiguous,
            COALESCE((SELECT json_agg(json_build_object('id', e.id, 'detected_at', e.detected_at, 'distance_meters', e.distance_meters,
                                                        'evidence_status', e.evidence_status, 'evidence_label', ${evidenceLabelSql('e.evidence_status')},
                                                        'ambiguous', e.ambiguous) ORDER BY e.detected_at)
                        FROM pid_visit_events e WHERE e.route_assignment_id = s.route_assignment_id AND e.pid_id = s.pid_id), '[]') AS events
       FROM pid_daily_status s
       ${joinRa('ra.id = s.route_assignment_id')}
      ${where.toSql()}
      ORDER BY ra.operational_date, s.route_assignment_id`,
    where.params);
  return { pid, from, to, days: rows };
}
