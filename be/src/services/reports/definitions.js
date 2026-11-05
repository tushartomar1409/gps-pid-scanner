// Report definitions (GUIDE #10 A, flow.txt §14). Columns follow flow §14; each report is ONE SQL
// statement whose output columns are exactly the column keys (sort whitelist = sortable keys).
import { env } from '../../config/env.js';
import { SqlWhere } from '../../utils/sql.js';
import { applyScope } from '../../middleware/scopeMiddleware.js';
import { MISSED_REASON_ORDER, evidenceSummary, visitStatusLabel } from './labels.js';

const RA_SCOPE = { zone: 'r.zone_id', ward: 'r.ward_id', agency: 'ra.agency_id' };
const pct = (num, den) => `round(100.0 * (${num}) / NULLIF(${den}, 0), 1)::float8`;

/** Column: { key, header, type: text|date|datetime|int|float|pct, width (xlsx chars), pdf (relative width) } */
const col = (key, header, type = 'text', width = 14, pdf = 1) => ({ key, header, type, width, pdf });

/** Shared assignment filters. tz() binds the timezone parameter on first use only (an unreferenced
 *  parameter has no inferable type and Postgres rejects the statement). */
function base(q, scope) {
  const w = new SqlWhere();
  let tzP = null;
  const tz = () => (tzP ??= w.param(env.APP_TIMEZONE));
  applyScope(w, scope, RA_SCOPE);
  const fromP = w.param(q.from);
  const toP = w.param(q.to);
  w.clauses.push(`ra.operational_date BETWEEN ${fromP}::date AND ${toP}::date`, "ra.status <> 'CANCELLED'");
  w.eq('r.zone_id', q.zone_id);
  w.eq('r.ward_id', q.ward_id);
  w.eq('ra.agency_id', q.agency_id);
  w.eq('ra.vehicle_id', q.vehicle_id);
  w.eq('ra.route_id', q.route_id);
  return { w, tz };
}

/** IST day window of a date expression. */
const dayWin = (d, tz) => ({ from: `(${d}::timestamp AT TIME ZONE ${tz})`, to: `((${d} + 1)::timestamp AT TIME ZONE ${tz})` });

// ---------- row-level reports (daily coverage, missed PIDs) ----------
const PID_ROW_FROM = `pid_daily_status s
  JOIN route_assignments ra ON ra.id = s.route_assignment_id
  JOIN routes r   ON r.id = ra.route_id
  JOIN zones z    ON z.id = r.zone_id
  JOIN wards w    ON w.id = r.ward_id
  JOIN pids p     ON p.id = s.pid_id
  JOIN vehicles v ON v.id = ra.vehicle_id
  LEFT JOIN agencies a ON a.id = ra.agency_id
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE e.evidence_status = 'PROXIMITY_POINT')::int AS points,
           (min(e.distance_meters) FILTER (WHERE e.evidence_status = 'PROXIMITY_POINT'))::float8 AS closest_m,
           count(*) FILTER (WHERE e.evidence_status = 'TRACK_SEGMENT')::int AS segments,
           count(*) FILTER (WHERE e.evidence_status = 'REJECTED_SPEED')::int AS rejected_speed,
           count(*) FILTER (WHERE e.evidence_status = 'REJECTED_STALE')::int AS rejected_stale,
           COALESCE(bool_or(e.ambiguous) FILTER (WHERE e.evidence_status IN ('PROXIMITY_POINT', 'TRACK_SEGMENT')), false) AS amb
      FROM pid_visit_events e WHERE e.route_assignment_id = s.route_assignment_id AND e.pid_id = s.pid_id) ev`;
const PID_ROW_SELECT = `s.operational_date::text AS date, z.zone_name AS zone, w.ward_name AS ward, p.pid_number, p.address,
  r.route_code AS route, v.vehicle_number AS vehicle, a.agency_name AS agency, s.visit_status,
  s.first_visit_at AS first_visit, s.last_visit_at AS last_visit, s.min_distance_meters::float8 AS distance_m,
  ev.points, ev.closest_m, ev.segments, ev.rejected_speed, ev.rejected_stale, (COALESCE(s.ambiguous, false) OR ev.amb) AS ambiguous,
  s.route_assignment_id, s.pid_id`;
const pidRecord = (r) => ({ ...r, visit_status_label: visitStatusLabel(r.visit_status), detection_evidence: evidenceSummary(r) });

const PID_COLS = [
  col('date', 'Date', 'date', 11, 0.8), col('zone', 'Zone', 'text', 14, 0.9), col('ward', 'Ward', 'text', 12, 0.8),
  col('pid_number', 'PID number', 'text', 14, 1), col('address', 'Address', 'text', 36, 2.4), col('route', 'Route', 'text', 12, 0.8),
  col('vehicle', 'Vehicle', 'text', 13, 0.9), col('agency', 'Agency', 'text', 16, 1),
];
const PID_TAIL = [
  col('first_visit', 'First visit (IST)', 'datetime', 17, 1), col('last_visit', 'Last visit (IST)', 'datetime', 17, 1),
  col('distance_m', 'Distance from PID (m)', 'float', 12, 0.7), col('detection_evidence', 'Detection evidence', 'text', 44, 2.2),
];

const dailyCoverage = {
  name: 'daily-coverage', title: 'Daily PID Coverage', flow: '§14.1',
  columns: [...PID_COLS, col('visit_status_label', 'Visit status', 'text', 20, 1.1), ...PID_TAIL],
  statusFilter: ['GPS_VISIT_CONFIRMED', 'GPS_VISIT_CANDIDATE', 'NOT_VISITED', 'GPS_DATA_UNAVAILABLE'],
  sortable: { date: 'date', zone: 'zone', ward: 'ward', pid_number: 'pid_number', route: 'route', vehicle: 'vehicle', agency: 'agency',
    visit_status_label: 'visit_status', first_visit: 'first_visit', last_visit: 'last_visit', distance_m: 'distance_m' },
  defaultSort: ['date', 'asc'], tiebreak: 'route, pid_number, route_assignment_id',
  build(q, scope) {
    const { w } = base(q, scope);
    w.eq('s.visit_status', q.status);
    return { text: `SELECT ${PID_ROW_SELECT} FROM ${PID_ROW_FROM} ${w.toSql()}`, values: w.params };
  },
  record: pidRecord,
};

const REASON_RANK = `CASE visit_status ${MISSED_REASON_ORDER.map((k, i) => `WHEN '${k}' THEN ${i}`).join(' ')} END`;
const missedPids = {
  name: 'missed-pids', title: 'Missed PIDs', flow: '§14.5',
  columns: [...PID_COLS, col('missed_reason', 'Missed reason', 'text', 22, 1.1), ...PID_TAIL],
  statusFilter: MISSED_REASON_ORDER, // ?status= filters by reason
  sortable: { missed_reason: REASON_RANK, date: 'date', zone: 'zone', ward: 'ward', pid_number: 'pid_number', route: 'route', vehicle: 'vehicle',
    agency: 'agency', last_visit: 'last_visit', distance_m: 'distance_m' },
  defaultSort: ['missed_reason', 'asc'], tiebreak: 'date, route, pid_number, route_assignment_id',
  build(q, scope, { ignoreStatus = false } = {}) {
    const { w } = base(q, scope);
    w.clauses.push("s.visit_status <> 'GPS_VISIT_CONFIRMED'");
    if (!ignoreStatus) w.eq('s.visit_status', q.status);
    return { text: `SELECT ${PID_ROW_SELECT} FROM ${PID_ROW_FROM} ${w.toSql()}`, values: w.params };
  },
  record: (r) => ({ ...pidRecord(r), missed_reason: visitStatusLabel(r.visit_status) }),
};

// ---------- aggregate reports ----------
/** One row per assignment with its PID counts (+ has_gps on its IST day), the base of every aggregate. */
function perAssignment(q, scope) {
  const { w, tz } = base(q, scope);
  const win = dayWin('ra.operational_date', tz());
  return {
    w, tz,
    cte: `per AS (
      SELECT ra.id, ra.operational_date AS d, ra.vehicle_id, ra.agency_id, r.zone_id, r.ward_id, r.route_code,
             c.assigned, c.confirmed, c.candidate,
             EXISTS (SELECT 1 FROM gps_locations g WHERE g.vehicle_id = ra.vehicle_id AND g.recorded_at >= ${win.from} AND g.recorded_at < ${win.to}) AS has_gps
        FROM route_assignments ra JOIN routes r ON r.id = ra.route_id
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS assigned,
                 count(*) FILTER (WHERE s.visit_status = 'GPS_VISIT_CONFIRMED')::int AS confirmed,
                 count(*) FILTER (WHERE s.visit_status = 'GPS_VISIT_CANDIDATE')::int AS candidate
            FROM pid_daily_status s WHERE s.route_assignment_id = ra.id) c
        ${w.toSql()})`,
  };
}
const SUMS = `sum(per.assigned)::int AS assigned_pids, sum(per.confirmed)::int AS gps_confirmed,
  (sum(per.assigned) - sum(per.confirmed))::int AS remaining,
  ${pct('sum(per.confirmed)', 'sum(per.assigned)')} AS confirmed_pct,
  ${pct('sum(per.confirmed) + sum(per.candidate)', 'sum(per.assigned)')} AS detected_pct`;
const SUM_COLS = [
  col('assigned_pids', 'Assigned PIDs', 'int', 10, 0.8), col('gps_confirmed', 'GPS confirmed', 'int', 10, 0.8),
  col('remaining', 'Remaining (not GPS-confirmed)', 'int', 12, 0.9), col('confirmed_pct', 'GPS confirmed %', 'pct', 11, 0.8),
  col('detected_pct', 'GPS visit detected %', 'pct', 11, 0.8),
];
const SUM_SORT = { assigned_pids: 'assigned_pids', gps_confirmed: 'gps_confirmed', remaining: 'remaining', confirmed_pct: 'confirmed_pct', detected_pct: 'detected_pct' };

const vehicleWise = {
  name: 'vehicle-wise', title: 'Vehicle-wise Report', flow: '§14.2',
  columns: [
    col('date', 'Date', 'date', 11, 0.8), col('vehicle', 'Vehicle', 'text', 13, 1), col('agency', 'Agency', 'text', 18, 1.2), col('route', 'Route', 'text', 14, 1),
    ...SUM_COLS, col('first_gps', 'First GPS activity (IST)', 'datetime', 17, 1.1), col('last_gps', 'Last GPS activity (IST)', 'datetime', 17, 1.1),
  ],
  sortable: { date: 'date', vehicle: 'vehicle', agency: 'agency', route: 'route', ...SUM_SORT, first_gps: 'first_gps', last_gps: 'last_gps' },
  defaultSort: ['date', 'asc'], tiebreak: 'vehicle',
  build(q, scope) {
    const p = perAssignment(q, scope);
    const win = dayWin('per.d', p.tz());
    return {
      text: `WITH ${p.cte}
        SELECT per.d::text AS date, v.vehicle_number AS vehicle,
               string_agg(DISTINCT a.agency_name, ', ') AS agency, string_agg(DISTINCT per.route_code, ', ') AS route, ${SUMS},
               (SELECT min(g.recorded_at) FROM gps_locations g WHERE g.vehicle_id = per.vehicle_id AND g.recorded_at >= ${win.from} AND g.recorded_at < ${win.to}) AS first_gps,
               (SELECT max(g.recorded_at) FROM gps_locations g WHERE g.vehicle_id = per.vehicle_id AND g.recorded_at >= ${win.from} AND g.recorded_at < ${win.to}) AS last_gps
          FROM per JOIN vehicles v ON v.id = per.vehicle_id LEFT JOIN agencies a ON a.id = per.agency_id
         GROUP BY per.d, per.vehicle_id, v.vehicle_number`,
      values: p.w.params,
    };
  },
  record: (r) => r,
};

const agencyWise = {
  name: 'agency-wise', title: 'Agency-wise Report', flow: '§14.3',
  columns: [
    col('agency', 'Agency', 'text', 24, 1.6), col('assigned_vehicles', 'Assigned vehicles', 'int', 10, 0.8),
    col('active_vehicles', 'Active vehicles (GPS on date)', 'int', 12, 0.9), ...SUM_COLS,
  ],
  sortable: { agency: 'agency', assigned_vehicles: 'assigned_vehicles', active_vehicles: 'active_vehicles', ...SUM_SORT },
  defaultSort: ['agency', 'asc'], tiebreak: 'agency_id',
  build(q, scope) {
    const p = perAssignment(q, scope);
    return {
      text: `WITH ${p.cte}
        SELECT per.agency_id, COALESCE(a.agency_name, '(no agency)') AS agency,
               count(DISTINCT per.vehicle_id)::int AS assigned_vehicles,
               count(DISTINCT per.vehicle_id) FILTER (WHERE per.has_gps)::int AS active_vehicles, ${SUMS}
          FROM per LEFT JOIN agencies a ON a.id = per.agency_id
         GROUP BY per.agency_id, a.agency_name`,
      values: p.w.params,
    };
  },
  record: ({ agency_id: _a, ...r }) => r,
};

const wardWise = {
  name: 'ward-wise', title: 'Ward-wise Report', flow: '§14.4',
  columns: [col('zone', 'Zone', 'text', 18, 1.2), col('ward', 'Ward', 'text', 18, 1.2), ...SUM_COLS],
  sortable: { zone: 'zone', ward: 'ward', ...SUM_SORT },
  defaultSort: ['zone', 'asc'], tiebreak: 'ward, ward_id',
  build(q, scope) {
    const p = perAssignment(q, scope);
    return {
      text: `WITH ${p.cte}
        SELECT per.ward_id, z.zone_name AS zone, w.ward_name AS ward, ${SUMS}
          FROM per JOIN zones z ON z.id = per.zone_id JOIN wards w ON w.id = per.ward_id
         GROUP BY per.zone_id, z.zone_name, per.ward_id, w.ward_name`,
      values: p.w.params,
    };
  },
  record: ({ ward_id: _w, ...r }) => r,
};

// ---------- vehicle tracking (export only, full resolution) ----------
export const TRACK_CAP = 50_000;
const vehicleTracking = {
  name: 'vehicle-tracking', title: 'Historical Vehicle Tracking', flow: '§14.6', exportOnly: true, formats: ['csv', 'xlsx'],
  columns: [
    col('time', 'Time (IST)', 'datetime', 18, 1), col('vehicle', 'Vehicle', 'text', 13, 1), col('latitude', 'Latitude', 'coord', 12, 1),
    col('longitude', 'Longitude', 'coord', 12, 1), col('speed', 'Speed (km/h)', 'float', 10, 0.8), col('ignition', 'Ignition', 'text', 8, 0.6),
  ],
  sortable: { time: 'time' }, defaultSort: ['time', 'asc'], tiebreak: 'id',
  build(q, scope) {
    const w = new SqlWhere();
    applyScope(w, scope, { zone: 'v.zone_id', ward: 'v.ward_id', agency: 'v.agency_id' });
    w.add('g.vehicle_id = ?', q.vehicle_id).add('g.recorded_at >= ?', q.window_from).add('g.recorded_at < ?', q.window_to);
    return {
      text: `SELECT g.id, g.recorded_at AS time, v.vehicle_number AS vehicle, g.latitude::float8 AS latitude, g.longitude::float8 AS longitude,
                    g.speed::float8 AS speed, CASE WHEN g.ignition IS NULL THEN NULL WHEN g.ignition THEN 'On' ELSE 'Off' END AS ignition
               FROM gps_locations g JOIN vehicles v ON v.id = g.vehicle_id ${w.toSql()}`,
      values: w.params,
    };
  },
  record: ({ id: _i, ...r }) => r,
};

export const REPORTS = Object.freeze({
  'daily-coverage': dailyCoverage,
  'vehicle-wise': vehicleWise,
  'agency-wise': agencyWise,
  'ward-wise': wardWise,
  'missed-pids': missedPids,
  'vehicle-tracking': vehicleTracking,
});

/** SELECT * FROM (<report>) t ORDER BY <whitelisted> + tiebreak. */
export function orderedSql(def, built, sort, dir) {
  const expr = def.sortable[sort] ?? def.sortable[def.defaultSort[0]];
  const d = (dir || def.defaultSort[1]) === 'desc' ? 'DESC' : 'ASC';
  return `SELECT * FROM (${built.text}) t ORDER BY ${expr} ${d} NULLS LAST, ${def.tiebreak}`;
}
