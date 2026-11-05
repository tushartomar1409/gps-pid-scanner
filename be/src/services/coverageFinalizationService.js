// End-of-window finalization + reprocessing (GUIDE #7 E, F).
import { gpsEvents } from './gps/gpsEvents.js';
import { recordActivity } from './activityLogService.js';
import { withTransaction } from '../config/database.js';
import { badRequest, notFound, unprocessable } from '../utils/errors.js';
import { applyScope } from '../middleware/scopeMiddleware.js';
import { SqlWhere } from '../utils/sql.js';

/** Assignment window: [shift_start, shift_end) or [D 00:00, D+1 12:00) in the operational TZ. */
const WINDOW_SQL = (alias, tzParam) => ({
  start: `COALESCE(${alias}.shift_start, (${alias}.operational_date::timestamp AT TIME ZONE ${tzParam}))`,
  end: `COALESCE(${alias}.shift_end, ((${alias}.operational_date + 1)::timestamp + interval '12 hours') AT TIME ZONE ${tzParam})`,
});

/**
 * Finalizes assignments whose window closed more than `grace` minutes ago, in ONE statement:
 * - no stored GPS point in the window at all -> NOT_VISITED becomes GPS_DATA_UNAVAILABLE
 * - status -> COMPLETED, finalized_at = now()
 * Skips assignments that still have unprocessed points in their window (detection backlog), so a
 * finalize never races the detector. Idempotent: finalized rows are never selected again.
 * $1 tz · $2 grace minutes · $3 max assignments
 */
export const FINALIZE_SQL = (() => {
  const w = WINDOW_SQL('ra', '$1');
  return `
WITH due AS (
  SELECT ra.id, ra.vehicle_id, ${w.start} AS ws, ${w.end} AS we
    FROM route_assignments ra
   WHERE ra.finalized_at IS NULL AND ra.status IN ('PLANNED', 'ACTIVE')
     AND ${w.end} + make_interval(mins => $2::int) < now()
   ORDER BY ra.id
   LIMIT $3
   FOR UPDATE SKIP LOCKED
),
ready AS (
  SELECT d.* FROM due d
   WHERE NOT EXISTS (SELECT 1 FROM gps_locations g
                      WHERE g.vehicle_id = d.vehicle_id AND g.processed_at IS NULL
                        AND g.recorded_at >= d.ws AND g.recorded_at < d.we)
),
nodata AS (
  SELECT r.id FROM ready r
   WHERE NOT EXISTS (SELECT 1 FROM gps_locations g
                      WHERE g.vehicle_id = r.vehicle_id AND g.recorded_at >= r.ws AND g.recorded_at < r.we)
),
unavailable AS (
  UPDATE pid_daily_status s SET visit_status = 'GPS_DATA_UNAVAILABLE'
   WHERE s.route_assignment_id IN (SELECT id FROM nodata) AND s.visit_status = 'NOT_VISITED'
  RETURNING s.route_assignment_id, s.pid_id
),
fin AS (
  UPDATE route_assignments SET status = 'COMPLETED', finalized_at = now()
   WHERE id IN (SELECT id FROM ready)
  RETURNING id
)
SELECT (SELECT count(*) FROM fin)::int AS finalized,
       (SELECT count(*) FROM nodata)::int AS without_data,
       (SELECT count(*) FROM due)::int - (SELECT count(*) FROM ready)::int AS deferred_backlog,
       COALESCE((SELECT json_agg(json_build_object('route_assignment_id', route_assignment_id, 'pid_id', pid_id)) FROM unavailable), '[]') AS unavailable`;
})();

export async function finalizeDue(db, settings, { limit = 500, emit = true } = {}) {
  const { rows: [r] } = await db.query(FINALIZE_SQL, [settings.timezone, settings.finalizeGraceMinutes, limit]);
  const changes = r.unavailable.map((c) => ({ ...c, old_status: 'NOT_VISITED', new_status: 'GPS_DATA_UNAVAILABLE' }));
  if (emit && changes.length) {
    gpsEvents.emit('detected', { assignmentIds: [...new Set(changes.map((c) => c.route_assignment_id))], pidStatusChanges: changes });
  }
  return { finalized: r.finalized, without_data: r.without_data, deferred_backlog: r.deferred_backlog, status_changes: changes.length };
}

// ---------------------------------------------------------------- reprocess (SUPER_ADMIN)

/**
 * Re-runs detection for assignments with the CURRENT settings. Derived data only:
 * deletes the assignment's pid_visit_events, resets its daily statuses to the initial state and marks
 * the vehicle's points in the window unprocessed. Raw gps_locations are never deleted.
 */
async function reprocessOne(tx, raId, settings, ctx) {
  const w = WINDOW_SQL('ra', '$2');
  const { rows: [ra] } = await tx.query(
    `SELECT ra.id, ra.vehicle_id, ra.status, ra.finalized_at, ${w.start} AS ws, ${w.end} AS we
       FROM route_assignments ra WHERE ra.id = $1 FOR UPDATE`, [raId, settings.timezone]);
  if (!ra) throw notFound(`Route assignment ${raId} not found`);
  if (ra.status === 'CANCELLED') throw unprocessable(`Route assignment ${raId} is cancelled`);
  const ev = await tx.query('DELETE FROM pid_visit_events WHERE route_assignment_id = $1', [raId]);
  const st = await tx.query(
    `UPDATE pid_daily_status s
        SET visit_status = CASE WHEN rap.pid_latitude IS NULL THEN 'GPS_DATA_UNAVAILABLE' ELSE 'NOT_VISITED' END,
            first_visit_at = NULL, last_visit_at = NULL, detection_count = 0, min_distance_meters = NULL,
            best_event_id = NULL, confirmed_at = NULL, ambiguous = false
       FROM route_assignment_pids rap
      WHERE s.route_assignment_id = $1 AND rap.route_assignment_id = s.route_assignment_id AND rap.pid_id = s.pid_id`, [raId]);
  const pts = await tx.query(
    'UPDATE gps_locations SET processed_at = NULL WHERE vehicle_id = $1 AND recorded_at >= $2 AND recorded_at < $3',
    [ra.vehicle_id, ra.ws, ra.we]);
  // Re-open so the finalizer evaluates it again once the re-detection is done.
  await tx.query(
    "UPDATE route_assignments SET finalized_at = NULL, status = CASE WHEN status = 'COMPLETED' THEN 'ACTIVE' ELSE status END WHERE id = $1",
    [raId]);
  const details = { events_deleted: ev.rowCount, statuses_reset: st.rowCount, points_requeued: pts.rowCount, settings };
  await recordActivity(ctx, { action: 'REPROCESS', module: 'detection', referenceId: raId, details }, tx);
  return { route_assignment_id: raId, ...details, settings: undefined };
}

export async function reprocess(body, settings, ctx, db) {
  let ids;
  if (body.route_assignment_id) ids = [body.route_assignment_id];
  else {
    const where = applyScope(new SqlWhere(), ctx.scope, { zone: 'r.zone_id', ward: 'r.ward_id', agency: 'ra.agency_id' })
      .add('ra.operational_date = ?', body.operational_date)
      .add("ra.status <> 'CANCELLED'");
    where.eq('r.zone_id', body.zone_id);
    const lim = where.param(501);
    const { rows } = await db.query(
      `SELECT ra.id FROM route_assignments ra JOIN routes r ON r.id = ra.route_id ${where.toSql()} ORDER BY ra.id LIMIT ${lim}`, where.params);
    if (rows.length > 500) throw badRequest('Reprocess is limited to 500 assignments per call; narrow it with zone_id');
    ids = rows.map((r) => Number(r.id));
  }
  const results = [];
  for (const id of ids) {
    // One transaction per assignment (GUIDE #7 F).
    results.push(await withTransaction((tx) => reprocessOne(tx, id, settings, ctx))); // eslint-disable-line no-await-in-loop
  }
  gpsEvents.emit('detection:wake', { reason: 'reprocess', assignmentIds: ids });
  return { assignments: results.length, results };
}
