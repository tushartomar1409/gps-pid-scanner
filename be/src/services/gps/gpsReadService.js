// Read side (GUIDE #6 E): live vehicles, history (SQL downsampling), provider status.
import { env } from '../../config/env.js';
import { db as defaultDb } from '../../config/database.js';
import { SqlWhere } from '../../utils/sql.js';
import { applyScope } from '../../middleware/scopeMiddleware.js';
import { getSetting } from '../settingsService.js';
import { todayInTz } from '../../utils/time.js';
import { badRequest, notFound } from '../../utils/errors.js';

export const LIVE_CAP = 5000;
export const MAX_HISTORY_MS = 24 * 3600 * 1000;
const VEHICLE_SCOPE = { zone: 'v.zone_id', ward: 'v.ward_id', agency: 'v.agency_id' };

export const offlineAfterSeconds = async () => Number(await getSetting('gps.offline_after_seconds', 300)) || 300;

/** SQL + params for the live view (exported for EXPLAIN in perf). */
export function buildLiveQuery(filters, scope, { offlineS, today, limit = LIVE_CAP }) {
  const where = applyScope(new SqlWhere(), scope, VEHICLE_SCOPE);
  where.eq('v.zone_id', filters.zone_id);
  where.eq('v.ward_id', filters.ward_id);
  where.eq('v.agency_id', filters.agency_id);
  where.eq('v.id', filters.vehicle_id);
  where.eq('v.vehicle_type', filters.vehicle_type);
  where.eq('ra.route_id', filters.route_id);
  const offP = where.param(offlineS);
  const dayP = where.param(today);
  const status = `CASE WHEN v.status <> 'ACTIVE' THEN 'INACTIVE'
                       WHEN l.vehicle_id IS NULL THEN 'NO_DATA'
                       WHEN l.recorded_at >= now() - make_interval(secs => ${offP}::int) THEN 'ONLINE'
                       ELSE 'OFFLINE' END`;
  const outer = new SqlWhere();
  outer.params = where.params; // share numbering
  if (filters.connection_status) outer.add('q.connection_status = ?', filters.connection_status);
  const limP = where.param(limit + 1);
  return {
    text: `SELECT * FROM (
      SELECT v.id AS vehicle_id, v.vehicle_number, v.vehicle_type, v.gps_device_id, v.status AS vehicle_status,
             v.agency_id, a.agency_name, v.zone_id, v.ward_id,
             l.latitude, l.longitude, l.speed, l.ignition, l.recorded_at, l.received_at, l.provider_status,
             ${status} AS connection_status,
             ra.id AS route_assignment_id, ra.route_id, r.route_code, ra.assigned_pid_count, ra.shift_start, ra.shift_end
        FROM vehicles v
        LEFT JOIN vehicle_latest_locations l ON l.vehicle_id = v.id
        LEFT JOIN agencies a ON a.id = v.agency_id
        LEFT JOIN LATERAL (
          SELECT x.id, x.route_id, x.assigned_pid_count, x.shift_start, x.shift_end FROM route_assignments x
           WHERE x.vehicle_id = v.id AND x.operational_date = ${dayP}::date AND x.status <> 'CANCELLED'
           ORDER BY (x.shift_start IS NOT NULL AND now() >= x.shift_start AND now() < x.shift_end) DESC, x.shift_start NULLS LAST
           LIMIT 1) ra ON true
        LEFT JOIN routes r ON r.id = ra.route_id
        ${where.toSql()}) q
      ${outer.toSql()}
      ORDER BY q.vehicle_number
      LIMIT ${limP}`,
    values: where.params,
  };
}

export async function liveVehicles(filters, scope, executor = defaultDb) {
  const q = buildLiveQuery(filters, scope, { offlineS: await offlineAfterSeconds(), today: todayInTz(env.APP_TIMEZONE) });
  const { rows } = await executor.query(q.text, q.values);
  const truncated = rows.length > LIVE_CAP;
  return { vehicles: truncated ? rows.slice(0, LIVE_CAP) : rows, truncated };
}

/**
 * History in [from, to] (≤ 24 h). If the window holds more than maxPoints, downsample evenly by
 * row number in SQL, always keeping the first and the last point.
 */
export function buildHistoryQuery(vehicleId, from, to, maxPoints) {
  return {
    text: `WITH w AS (
      SELECT id, latitude, longitude, speed, ignition, heading, recorded_at,
             row_number() OVER (ORDER BY recorded_at) AS rn, count(*) OVER () AS total
        FROM gps_locations WHERE vehicle_id = $1 AND recorded_at BETWEEN $2 AND $3)
      SELECT id, latitude, longitude, speed, ignition, heading, recorded_at, total
        FROM w
       WHERE total <= $4 OR rn = 1 OR rn = total
          OR (rn - 1) % GREATEST(1, ceil((total - 1)::numeric / GREATEST($4 - 2, 1)))::bigint = 0
       ORDER BY recorded_at`,
    values: [vehicleId, from, to, maxPoints],
  };
}

export async function vehicleHistory({ vehicle_id: vehicleId, from, to, max_points: maxPoints = 5000 }, scope, executor = defaultDb) {
  const f = new Date(from);
  const t = new Date(to);
  if (!(t > f)) throw badRequest('`to` must be after `from`');
  if (t - f > MAX_HISTORY_MS) throw badRequest('History window may span at most 24 hours');
  await assertVehicleVisible(vehicleId, scope, executor);
  const q = buildHistoryQuery(vehicleId, f, t, maxPoints);
  const { rows } = await executor.query(q.text, q.values);
  const total = rows.length ? Number(rows[0].total) : 0;
  return {
    vehicle_id: vehicleId,
    from: f.toISOString(),
    to: t.toISOString(),
    total_in_window: total,
    downsampled: total > maxPoints,
    points: rows.map(({ total: _t, ...p }) => p),
  };
}

export async function latestLocation(vehicleId, scope, executor = defaultDb) {
  const { vehicles } = await liveVehicles({ vehicle_id: vehicleId }, scope, executor);
  if (!vehicles.length) throw notFound('Vehicle not found');
  return vehicles[0];
}

async function assertVehicleVisible(vehicleId, scope, executor) {
  const where = applyScope(new SqlWhere(), scope, VEHICLE_SCOPE).add('v.id = ?', vehicleId);
  const { rowCount } = await executor.query(`SELECT 1 FROM vehicles v ${where.toSql()}`, where.params);
  if (!rowCount) throw notFound('Vehicle not found');
}

/**
 * Provider status state machine.
 *   UNKNOWN  — no finished run at all (never polled)
 *   DOWN     — ≥ 3 consecutive FAILED runs, or no successful run within 5 × interval
 *   DEGRADED — last finished run PARTIAL, or > 20 % of its received points rejected
 *   UP       — otherwise
 */
export function deriveProviderState(runs, { intervalMs, now = Date.now() }) {
  const finished = runs.filter((r) => r.outcome !== 'RUNNING');
  let consecutiveFailures = 0;
  for (const r of finished) {
    if (r.outcome !== 'FAILED') break;
    consecutiveFailures++;
  }
  const lastSuccess = finished.find((r) => r.outcome === 'SUCCESS' || r.outcome === 'PARTIAL');
  const lastSuccessAt = lastSuccess ? new Date(lastSuccess.finished_at || lastSuccess.started_at) : null;
  const last = finished[0] || null;
  let state = 'UP';
  let reason = null;
  if (!finished.length) [state, reason] = ['UNKNOWN', 'No poll has run yet']; // grey, not an outage (GUIDE #7)
  else if (consecutiveFailures >= 3) [state, reason] = ['DOWN', `${consecutiveFailures} consecutive failed runs`];
  else if (!lastSuccessAt || now - lastSuccessAt.getTime() > 5 * intervalMs) {
    [state, reason] = ['DOWN', lastSuccessAt ? 'No successful run within 5 poll intervals' : 'No successful run yet'];
  } else if (last && (last.outcome === 'PARTIAL' || (last.records_received > 0 && last.records_rejected / last.records_received > 0.2))) {
    [state, reason] = ['DEGRADED', last.outcome === 'PARTIAL' ? 'Last run rejected some points' : 'More than 20% of points rejected'];
  }
  return { state, reason, consecutive_failures: consecutiveFailures, last_success_at: lastSuccessAt?.toISOString() ?? null, last_run: last };
}

export async function providerStatus(providerName, { intervalMs = env.GPS_POLL_INTERVAL_SECONDS * 1000, executor = defaultDb } = {}) {
  const { rows } = await executor.query(
    `SELECT id, provider, trigger, started_at, finished_at, outcome, records_received, records_saved, records_rejected,
            rejected_breakdown, error_message
       FROM gps_poll_runs WHERE provider = $1 ORDER BY started_at DESC LIMIT 20`, [providerName]);
  const derived = deriveProviderState(rows, { intervalMs });
  return { provider: providerName, poll_interval_seconds: intervalMs / 1000, ...derived, recent_runs: rows };
}
