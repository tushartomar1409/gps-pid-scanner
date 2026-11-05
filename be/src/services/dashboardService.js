// Dashboard APIs (flow.txt §13, GUIDE #8 C). Every number comes from real tables, each endpoint is ONE
// SQL statement, and every query applies the caller's row scope.
// Wording rule (GUIDE #8 answer 2): "GPS confirmed" / "GPS detected" — never "collected".
import { env } from '../config/env.js';
import { db as defaultDb } from '../config/database.js';
import { SqlWhere } from '../utils/sql.js';
import { applyScope } from '../middleware/scopeMiddleware.js';
import { PID_SCOPE } from '../repositories/pidRepository.js';
import { todayInTz, daysBetween } from '../utils/time.js';
import { getSetting } from './settingsService.js';
import { badRequest } from '../utils/errors.js';

export const GPS_DISCLAIMER = 'GPS proximity indicates that a vehicle passed near the property. It does not prove that garbage was collected.';

const RA_SCOPE = { zone: 'r.zone_id', ward: 'r.ward_id', agency: 'ra.agency_id' };
const VEHICLE_SCOPE = { zone: 'v.zone_id', ward: 'v.ward_id', agency: 'v.agency_id' };
const pct = (num, den) => `round(100.0 * (${num}) / NULLIF(${den}, 0), 1)::float8`;

/** Shared parameter list, separate WHERE clauses per sub-query. */
function builder() {
  const w = new SqlWhere();
  return {
    w,
    p: (v) => w.param(v),
    where(fn) {
      const start = w.clauses.length;
      fn(w);
      const part = w.clauses.splice(start);
      return part.length ? `WHERE ${part.join(' AND ')}` : '';
    },
  };
}

function assignmentFilters(w, q, scope, dateP) {
  applyScope(w, scope, RA_SCOPE);
  w.clauses.push(`s.operational_date = ${dateP}::date`, "ra.status <> 'CANCELLED'");
  w.eq('r.zone_id', q.zone_id);
  w.eq('r.ward_id', q.ward_id);
  w.eq('ra.agency_id', q.agency_id);
  w.eq('ra.vehicle_id', q.vehicle_id);
}
const ASSIGN_FROM = `pid_daily_status s
  JOIN route_assignments ra ON ra.id = s.route_assignment_id
  JOIN routes r ON r.id = ra.route_id`;
const COUNTS = `count(*)::int AS assigned,
  count(*) FILTER (WHERE s.visit_status = 'GPS_VISIT_CONFIRMED')::int AS confirmed,
  count(*) FILTER (WHERE s.visit_status = 'GPS_VISIT_CANDIDATE')::int AS candidate,
  count(*) FILTER (WHERE s.visit_status = 'GPS_DATA_UNAVAILABLE')::int AS unavailable`;
const DERIVED = (a = '') => `${a}assigned - ${a}confirmed AS remaining,
  ${a}assigned - ${a}confirmed - ${a}candidate AS remaining_undetected,
  ${pct(`${a}confirmed`, `${a}assigned`)} AS confirmed_pct,
  ${pct(`${a}confirmed + ${a}candidate`, `${a}assigned`)} AS detected_pct`;

const dayWindow = (dateP, tzP) => ({
  from: `(${dateP}::date::timestamp AT TIME ZONE ${tzP})`,
  to: `((${dateP}::date + 1)::timestamp AT TIME ZONE ${tzP})`,
});

export function buildSummaryQuery(q, scope, { offlineS = 300, tz = env.APP_TIMEZONE } = {}) {
  const b = builder();
  const dateP = b.p(q.date);
  const tzP = b.p(tz);
  const offP = b.p(offlineS);
  const win = dayWindow(dateP, tzP);
  const assignWhere = b.where((w) => assignmentFilters(w, q, scope, dateP));
  const vehWhere = b.where((w) => {
    applyScope(w, scope, VEHICLE_SCOPE);
    w.eq('v.zone_id', q.zone_id); w.eq('v.ward_id', q.ward_id); w.eq('v.agency_id', q.agency_id); w.eq('v.id', q.vehicle_id);
  });
  const pidWhere = b.where((w) => {
    applyScope(w, scope, PID_SCOPE);
    w.clauses.push("p.status = 'ACTIVE'");
    w.eq('p.zone_id', q.zone_id); w.eq('p.ward_id', q.ward_id);
  });
  return {
    text: `
WITH pd AS (SELECT ${COUNTS} FROM ${ASSIGN_FROM} ${assignWhere}),
veh AS (
  SELECT count(*) FILTER (WHERE v.status = 'ACTIVE')::int AS total_vehicles, -- registered ACTIVE vehicles (GUIDE #9 answer 2)
         count(*) FILTER (WHERE v.status = 'ACTIVE' AND x.has_gps)::int     AS active_vehicles,
         count(*) FILTER (WHERE v.status = 'ACTIVE' AND NOT x.has_gps)::int AS offline_vehicles,
         count(*) FILTER (WHERE v.status = 'ACTIVE' AND l.recorded_at >= now() - make_interval(secs => ${offP}::int))::int AS online_now
    FROM vehicles v
    LEFT JOIN vehicle_latest_locations l ON l.vehicle_id = v.id
    CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM gps_locations g
                                        WHERE g.vehicle_id = v.id AND g.recorded_at >= ${win.from} AND g.recorded_at < ${win.to})) AS x(has_gps)
    ${vehWhere}
),
reg AS (SELECT count(*)::int AS total_registered_pids FROM pids p ${pidWhere})
SELECT veh.*, reg.total_registered_pids, pd.assigned AS assigned_pids, pd.confirmed AS gps_confirmed_pids,
       pd.confirmed + pd.candidate AS gps_detected_pids, pd.candidate AS gps_candidate_pids, pd.unavailable AS gps_unavailable_pids,
       pd.assigned - pd.confirmed AS remaining_pids,
       pd.assigned - pd.confirmed - pd.candidate AS remaining_undetected_pids,
       ${pct('pd.confirmed', 'pd.assigned')} AS gps_confirmed_coverage_pct,
       ${pct('pd.confirmed + pd.candidate', 'pd.assigned')} AS gps_visit_detected_pct
  FROM veh, reg, pd`,
    values: b.w.params,
  };
}

export async function summary(q, scope, db = defaultDb) {
  const qq = buildSummaryQuery(q, scope, { offlineS: Number(await getSetting('gps.offline_after_seconds', 300)) || 300 });
  const { rows: [r] } = await db.query(qq.text, qq.values);
  return { date: q.date, ...r, disclaimer: GPS_DISCLAIMER };
}

const GROUPS = {
  zone: { key: 'r.zone_id', label: 'z.zone_name', join: 'JOIN zones z ON z.id = r.zone_id' },
  ward: { key: 'r.ward_id', label: 'w.ward_name', join: 'JOIN wards w ON w.id = r.ward_id' },
  agency: { key: 'ra.agency_id', label: "COALESCE(a.agency_name, '(no agency)')", join: 'LEFT JOIN agencies a ON a.id = ra.agency_id' },
  vehicle: { key: 'ra.vehicle_id', label: 'v.vehicle_number', join: 'JOIN vehicles v ON v.id = ra.vehicle_id' },
};

export function buildGroupedQuery(group, q, scope, { tz = env.APP_TIMEZONE } = {}) {
  const g = GROUPS[group];
  const b = builder();
  const dateP = b.p(q.date);
  // Only the vehicle grouping uses the day window; never bind an unreferenced parameter.
  const win = group === 'vehicle' ? dayWindow(dateP, b.p(tz)) : null;
  const where = b.where((w) => assignmentFilters(w, q, scope, dateP));
  const activity = group === 'vehicle'
    ? `, (SELECT min(gl.recorded_at) FROM gps_locations gl WHERE gl.vehicle_id = ra.vehicle_id AND gl.recorded_at >= ${win.from} AND gl.recorded_at < ${win.to}) AS first_gps_activity,
         (SELECT max(gl.recorded_at) FROM gps_locations gl WHERE gl.vehicle_id = ra.vehicle_id AND gl.recorded_at >= ${win.from} AND gl.recorded_at < ${win.to}) AS last_gps_activity`
    : '';
  return {
    text: `SELECT t.*, ${DERIVED('t.')} FROM (
      SELECT ${g.key} AS group_id, ${g.label} AS group_name, ${COUNTS} ${activity}
        FROM ${ASSIGN_FROM} ${g.join}
        ${where}
       GROUP BY ${g.key}, ${g.label}${group === 'vehicle' ? ', ra.vehicle_id' : ''}) t
     ORDER BY t.group_name`,
    values: b.w.params,
  };
}

export async function grouped(group, q, scope, db = defaultDb) {
  const qq = buildGroupedQuery(group, q, scope);
  const { rows } = await db.query(qq.text, qq.values);
  return { date: q.date, group_by: group, groups: rows, disclaimer: GPS_DISCLAIMER };
}

export async function dailyTrend(q, scope, db = defaultDb) {
  if (q.to < q.from) throw badRequest('`to` must be on or after `from`');
  if (daysBetween(q.from, q.to) > 30) throw badRequest('Trend range may span at most 31 days');
  const b = builder();
  const fromP = b.p(q.from);
  const toP = b.p(q.to);
  const where = b.where((w) => {
    applyScope(w, scope, RA_SCOPE);
    w.clauses.push(`s.operational_date BETWEEN ${fromP}::date AND ${toP}::date`, "ra.status <> 'CANCELLED'");
    w.eq('r.zone_id', q.zone_id); w.eq('r.ward_id', q.ward_id); w.eq('ra.agency_id', q.agency_id); w.eq('ra.vehicle_id', q.vehicle_id);
  });
  const { rows } = await db.query(
    `SELECT d::date::text AS date, COALESCE(a.assigned, 0) AS assigned, COALESCE(a.confirmed, 0) AS confirmed,
            COALESCE(a.confirmed + a.candidate, 0) AS detected,
            ${pct('a.confirmed', 'a.assigned')} AS confirmed_pct, ${pct('a.confirmed + a.candidate', 'a.assigned')} AS detected_pct
       FROM generate_series(${fromP}::date, ${toP}::date, interval '1 day') d
       LEFT JOIN (SELECT s.operational_date, ${COUNTS} FROM ${ASSIGN_FROM} ${where} GROUP BY s.operational_date) a
              ON a.operational_date = d::date
      ORDER BY d`,
    b.w.params);
  return { from: q.from, to: q.to, days: rows, disclaimer: GPS_DISCLAIMER };
}

export function buildHourlyQuery(q, scope, { tz = env.APP_TIMEZONE } = {}) {
  const b = builder();
  const dateP = b.p(q.date);
  const tzP = b.p(tz);
  const win = dayWindow(dateP, tzP);
  const gpsWhere = b.where((w) => {
    applyScope(w, scope, VEHICLE_SCOPE);
    w.clauses.push(`g.recorded_at >= ${win.from}`, `g.recorded_at < ${win.to}`);
    w.eq('v.zone_id', q.zone_id); w.eq('v.ward_id', q.ward_id); w.eq('v.agency_id', q.agency_id); w.eq('v.id', q.vehicle_id);
  });
  const evWhere = b.where((w) => {
    applyScope(w, scope, RA_SCOPE);
    w.clauses.push(`ra.operational_date = ${dateP}::date`, "e.evidence_status IN ('PROXIMITY_POINT', 'TRACK_SEGMENT')");
    w.eq('r.zone_id', q.zone_id); w.eq('r.ward_id', q.ward_id); w.eq('ra.agency_id', q.agency_id); w.eq('ra.vehicle_id', q.vehicle_id);
  });
  return {
    text: `SELECT h AS hour, COALESCE(gp.n, 0)::int AS gps_points, COALESCE(ev.n, 0)::int AS visit_events
       FROM generate_series(0, 23) h
       LEFT JOIN (SELECT extract(hour FROM g.recorded_at AT TIME ZONE ${tzP})::int AS h, count(*) AS n
                    FROM gps_locations g JOIN vehicles v ON v.id = g.vehicle_id ${gpsWhere} GROUP BY 1) gp USING (h)
       LEFT JOIN (SELECT extract(hour FROM e.detected_at AT TIME ZONE ${tzP})::int AS h, count(*) AS n
                    FROM pid_visit_events e JOIN route_assignments ra ON ra.id = e.route_assignment_id JOIN routes r ON r.id = ra.route_id
                    ${evWhere} GROUP BY 1) ev USING (h)
      ORDER BY h`,
    values: b.w.params,
  };
}

export async function hourlyActivity(q, scope, db = defaultDb) {
  const qq = buildHourlyQuery(q, scope);
  const { rows } = await db.query(qq.text, qq.values);
  return { date: q.date, timezone: env.APP_TIMEZONE, hours: rows };
}

export const defaultDate = () => todayInTz(env.APP_TIMEZONE);
