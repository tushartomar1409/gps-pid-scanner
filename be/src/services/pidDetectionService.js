// PID visit detection engine (flow.txt §8, GUIDE #7). Set-based: one batch =
//   BEGIN · Q1 (claim + resolve + gate + candidates + events + mark processed) · Q2 (recompute statuses) · COMMIT
// = 4 round trips, whatever the batch size. Idempotent: events are ON CONFLICT DO NOTHING and daily
// statuses are recomputed from ALL events of each affected (assignment, PID) pair — never incremented.
import { gpsEvents } from './gps/gpsEvents.js';
import { M_PER_DEG_LAT, MIN_COS_LAT } from '../utils/haversine.js';

export const DEFAULT_BATCH_SIZE = 5000;

// ---------------------------------------------------------------- Q1: claim + events
// $1 batch size · $2 tz · $3 radius m · $4 max age s · $5 policy · $6 min speed · $7 max speed
// $8 metres/deg-lat · $9 min cos(lat)
export const CLAIM_AND_DETECT_SQL = `
WITH batch AS (
  SELECT g.id, g.vehicle_id, g.latitude::float8 AS lat, g.longitude::float8 AS lng, g.speed, g.recorded_at, g.received_at
    FROM gps_locations g
   WHERE g.processed_at IS NULL
   ORDER BY g.vehicle_id, g.recorded_at
   LIMIT $1
   FOR UPDATE SKIP LOCKED
),
asg AS (
  -- Q1/Q2 rule (GUIDE #2): shift window containing recorded_at, else the vehicle's all-day
  -- assignment on the IST date of recorded_at.
  SELECT b.*, ra.id AS ra_id, ra.finalized_at
    FROM batch b
    LEFT JOIN LATERAL (
      SELECT x.id, x.finalized_at FROM route_assignments x
       WHERE x.vehicle_id = b.vehicle_id AND x.status <> 'CANCELLED'
         AND ((x.shift_start IS NOT NULL AND b.recorded_at >= x.shift_start AND b.recorded_at < x.shift_end)
              OR (x.shift_start IS NULL AND x.operational_date = (b.recorded_at AT TIME ZONE $2)::date))
       ORDER BY (x.shift_start IS NOT NULL) DESC, x.id
       LIMIT 1) ra ON true
),
gated AS (
  SELECT a.*,
         CASE
           WHEN $5 = 'evidence_only' AND a.received_at - a.recorded_at > make_interval(secs => $4::int) THEN 'REJECTED_STALE'
           WHEN a.speed IS NOT NULL AND (($6::numeric IS NOT NULL AND a.speed < $6::numeric) OR ($7::numeric IS NOT NULL AND a.speed > $7::numeric))
             THEN 'REJECTED_SPEED'
           ELSE 'PROXIMITY_POINT'
         END AS evidence
    FROM asg a WHERE a.ra_id IS NOT NULL
),
cand AS (
  -- Snapshot coordinates (not pids): history never moves when a PID is corrected later.
  -- LATERAL = one index probe per point on idx_rap_ra_lat_lng (route_assignment_id, pid_latitude,
  -- pid_longitude) using the bbox, regardless of how large the snapshot table grows over the years.
  -- haversine_m() is the exact filter.
  SELECT g.id AS gps_id, g.vehicle_id, g.ra_id, g.recorded_at, g.speed, g.evidence, c.pid_id, c.dist
    FROM gated g
    CROSS JOIN LATERAL (
      SELECT rap.pid_id, haversine_m(g.lat, g.lng, rap.pid_latitude::float8, rap.pid_longitude::float8) AS dist
        FROM route_assignment_pids rap
       WHERE rap.route_assignment_id = g.ra_id
         AND rap.pid_latitude  BETWEEN (g.lat - $3::float8 / $8::float8 * 1.01)::numeric AND (g.lat + $3::float8 / $8::float8 * 1.01)::numeric
         AND rap.pid_longitude BETWEEN (g.lng - $3::float8 / ($8::float8 * greatest(cos(radians(g.lat)), $9::float8)) * 1.01)::numeric
                                   AND (g.lng + $3::float8 / ($8::float8 * greatest(cos(radians(g.lat)), $9::float8)) * 1.01)::numeric
      OFFSET 0  -- keep the per-point index probe; without it the planner flattens this into a hash join + seq scan
    ) c
   WHERE c.dist <= $3::float8
),
amb AS (SELECT gps_id, ra_id, count(*)::int AS n FROM cand GROUP BY gps_id, ra_id),
ins AS (
  INSERT INTO pid_visit_events (route_assignment_id, pid_id, vehicle_id, gps_location_id, distance_meters,
                                speed_at_detection, detected_at, evidence_status, ambiguous, pids_in_radius)
  SELECT c.ra_id, c.pid_id, c.vehicle_id, c.gps_id, round(c.dist::numeric, 2), c.speed, c.recorded_at, c.evidence, a.n >= 2, a.n
    FROM cand c JOIN amb a ON a.gps_id = c.gps_id AND a.ra_id = c.ra_id
  ON CONFLICT (route_assignment_id, pid_id, gps_location_id) DO NOTHING
  RETURNING id
),
activate AS (
  -- id = ANY(array) -> primary-key index scans (an IN-subquery here was planned as a seq scan).
  UPDATE route_assignments SET status = 'ACTIVE'
   WHERE id = ANY ((SELECT array_agg(DISTINCT ra_id) FROM asg WHERE ra_id IS NOT NULL)::bigint[]) AND status = 'PLANNED'
  RETURNING id
),
late_log AS (
  INSERT INTO activity_logs (action, module, reference_id, details)
  SELECT 'LATE_DATA_AFTER_FINALIZE', 'detection', ra_id::text,
         jsonb_build_object('points', count(*), 'oldest_recorded_at', min(recorded_at), 'newest_recorded_at', max(recorded_at))
    FROM asg WHERE ra_id IS NOT NULL AND finalized_at IS NOT NULL GROUP BY ra_id
  RETURNING 1
),
done AS (
  UPDATE gps_locations SET processed_at = now()
   WHERE id = ANY ((SELECT array_agg(id) FROM batch)::bigint[]) -- pkey index, never a full scan of history
  RETURNING id
)
SELECT (SELECT count(*) FROM batch)::int                       AS points,
       (SELECT count(*) FROM asg WHERE ra_id IS NULL)::int      AS unassigned_points,
       (SELECT count(*) FROM gated WHERE evidence <> 'PROXIMITY_POINT')::int AS rejected_points,
       (SELECT count(*) FROM ins)::int                          AS events_inserted,
       (SELECT count(*) FROM activate)::int                     AS assignments_activated,
       (SELECT count(*) FROM late_log)::int                     AS late_after_finalize,
       COALESCE((SELECT array_agg(ra_id) FROM (SELECT DISTINCT ra_id, pid_id FROM cand) p), '{}') AS pair_ra,
       COALESCE((SELECT array_agg(pid_id) FROM (SELECT DISTINCT ra_id, pid_id FROM cand) p), '{}') AS pair_pid`;

// ---------------------------------------------------------------- Q2: recompute statuses
// $1 ra ids · $2 pid ids · $3 mode · $4 N · $5 window s · $6 dwell s
// Status rank: CONFIRMED 3 > CANDIDATE 2 > others 1 — a recompute never lowers a status.
export const RECOMPUTE_SQL = `
WITH pairs AS (
  SELECT DISTINCT * FROM unnest($1::bigint[], $2::bigint[]) AS p(ra_id, pid_id)
),
valid AS MATERIALIZED (
  -- One index probe per pair on (route_assignment_id, pid_id, ...): OFFSET 0 stops the planner from
  -- flattening this into a hash join over the whole (ever-growing) events table.
  SELECT p.ra_id, p.pid_id, e.id, e.vehicle_id, e.detected_at, e.distance_meters, e.ambiguous
    FROM pairs p
    CROSS JOIN LATERAL (
      SELECT x.id, x.vehicle_id, x.detected_at, x.distance_meters, x.ambiguous
        FROM pid_visit_events x
       WHERE x.route_assignment_id = p.ra_id AND x.pid_id = p.pid_id AND x.evidence_status = 'PROXIMITY_POINT'
      OFFSET 0) e
),
ordered AS (
  -- lag() for adjacency and the min_events window count in ONE window pass.
  SELECT v.*, lag(v.detected_at) OVER w AS prev_at,
         count(*) OVER (PARTITION BY v.ra_id, v.pid_id ORDER BY v.detected_at
                        RANGE BETWEEN CURRENT ROW AND make_interval(secs => $5::int) FOLLOWING) AS win_cnt
    FROM valid v WINDOW w AS (PARTITION BY v.ra_id, v.pid_id ORDER BY v.detected_at)
),
adj AS (
  -- Adjacent = no OTHER point of this vehicle between the two events (any point, in radius or not,
  -- processed or not). Uses the (vehicle_id, recorded_at) unique index; late points are naturally included.
  SELECT o.*,
         CASE WHEN o.prev_at IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM gps_locations g
                 WHERE g.vehicle_id = o.vehicle_id AND g.recorded_at > o.prev_at AND g.recorded_at < o.detected_at)
              THEN 0 ELSE 1 END AS brk
    FROM ordered o
),
islands AS (
  SELECT a.*, sum(a.brk) OVER (PARTITION BY a.ra_id, a.pid_id ORDER BY a.detected_at) AS grp FROM adj a
),
per_island AS (
  -- Level 1: one row per run of adjacent in-radius points (island).
  SELECT ra_id, pid_id, grp, count(*) AS n, min(detected_at) AS first_at, max(detected_at) AS last_at,
         min(distance_meters) AS min_d, bool_or(ambiguous) AS any_amb, max(win_cnt) AS max_win,
         (array_agg(id ORDER BY distance_meters, detected_at, id))[1] AS best_id
    FROM islands GROUP BY ra_id, pid_id, grp
),
computed AS (
  -- Level 2: one row per pair. Single aggregation pass — no joins between aggregates (those were
  -- planned as nested loops over 1-row CTE estimates and exploded quadratically).
  SELECT ra_id, pid_id, min(first_at) AS first_at, max(last_at) AS last_at, sum(n)::int AS cnt,
         min(min_d) AS min_d, bool_or(any_amb) AS any_amb,
         (array_agg(best_id ORDER BY min_d, first_at, best_id))[1] AS best_id,
         CASE WHEN (CASE $3
                      WHEN 'consecutive_points' THEN max(n) >= $4::int
                      WHEN 'min_events' THEN max(max_win) >= $4::int
                      WHEN 'dwell' THEN max(extract(epoch FROM last_at - first_at)) >= $6::int
                    END) THEN 'GPS_VISIT_CONFIRMED' ELSE 'GPS_VISIT_CANDIDATE' END AS new_status
    FROM per_island GROUP BY ra_id, pid_id
),
with_old AS (
  -- Pre-update status read alongside each pair (index probe per pair) and carried through the UPDATE's
  -- RETURNING, so no CTE-to-CTE join is needed afterwards (that join was planned as a quadratic
  -- nested loop: 11k × 11k = 124M comparisons).
  SELECT c.*, s.visit_status AS old_status
    FROM computed c JOIN pid_daily_status s ON s.route_assignment_id = c.ra_id AND s.pid_id = c.pid_id
),
upd AS (
  UPDATE pid_daily_status s SET
    visit_status = CASE
      WHEN (CASE c.new_status WHEN 'GPS_VISIT_CONFIRMED' THEN 3 ELSE 2 END)
         > (CASE s.visit_status WHEN 'GPS_VISIT_CONFIRMED' THEN 3 WHEN 'GPS_VISIT_CANDIDATE' THEN 2 ELSE 1 END)
      THEN c.new_status ELSE s.visit_status END,
    first_visit_at = c.first_at, last_visit_at = c.last_at, detection_count = c.cnt,
    min_distance_meters = c.min_d, best_event_id = c.best_id, ambiguous = c.any_amb,
    confirmed_at = CASE WHEN c.new_status = 'GPS_VISIT_CONFIRMED' THEN COALESCE(s.confirmed_at, now()) ELSE s.confirmed_at END
    FROM with_old c
   WHERE s.route_assignment_id = c.ra_id AND s.pid_id = c.pid_id
  RETURNING s.route_assignment_id, s.pid_id, c.old_status, s.visit_status AS new_status
)
SELECT route_assignment_id, pid_id, old_status, new_status
  FROM upd
 WHERE old_status IS DISTINCT FROM new_status`;

/**
 * Processes ONE batch in one transaction. `pool` must provide connect() (transaction client).
 * Returns stats + the status changes (already committed) — or null when nothing was claimed.
 */
export async function detectBatch(pool, settings, { batchSize = DEFAULT_BATCH_SIZE, countQuery, onQueryTime } = {}) {
  const client = await pool.connect();
  const q = async (text, params) => {
    countQuery?.();
    const t0 = performance.now();
    try {
      return await client.query(text, params);
    } finally {
      onQueryTime?.(text.trim().split(/\s+/)[0] === 'WITH' ? (text.includes('pairs AS') ? 'recompute' : 'claim') : text.trim(), performance.now() - t0);
    }
  };
  try {
    await q('BEGIN');
    const { rows: [r1] } = await q(CLAIM_AND_DETECT_SQL, [
      batchSize, settings.timezone, settings.radiusM, settings.maxGpsAgeS, settings.latePointsPolicy,
      settings.minSpeedKmh, settings.maxSpeedKmh, M_PER_DEG_LAT, MIN_COS_LAT,
    ]);
    let changes = [];
    if (r1.pair_ra.length) {
      ({ rows: changes } = await q(RECOMPUTE_SQL, [
        r1.pair_ra, r1.pair_pid, settings.confirmationMode, settings.consecutivePoints,
        settings.confirmationWindowS, settings.minDwellSeconds,
      ]));
    }
    await q('COMMIT');
    if (r1.points === 0) return null;
    const pidStatusChanges = changes.map((c) => ({ ...c, route_assignment_id: Number(c.route_assignment_id), pid_id: Number(c.pid_id) }));
    return { ...r1, affected_pairs: r1.pair_ra.length, pidStatusChanges, pair_ra: undefined, pair_pid: undefined };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Drains the backlog batch by batch; emits 'detected' after each committed batch with changes. */
export async function runDetection(pool, settings, { batchSize = DEFAULT_BATCH_SIZE, maxBatches = Infinity, countQuery, emit = true } = {}) {
  const total = { batches: 0, points: 0, events_inserted: 0, unassigned_points: 0, rejected_points: 0, status_changes: 0, assignments_activated: 0, late_after_finalize: 0 };
  if (!settings.enabled) return { ...total, skipped: 'detection.enabled=false' };
  for (let i = 0; i < maxBatches; i++) {
    // eslint-disable-next-line no-await-in-loop -- batches are claimed sequentially until the backlog is empty
    const r = await detectBatch(pool, settings, { batchSize, countQuery });
    if (!r) break;
    total.batches++;
    for (const k of ['points', 'events_inserted', 'unassigned_points', 'rejected_points', 'assignments_activated', 'late_after_finalize']) total[k] += r[k];
    total.status_changes += r.pidStatusChanges.length;
    if (emit && r.pidStatusChanges.length) {
      gpsEvents.emit('detected', {
        assignmentIds: [...new Set(r.pidStatusChanges.map((c) => c.route_assignment_id))],
        pidStatusChanges: r.pidStatusChanges,
      });
    }
    if (r.points < batchSize) break;
  }
  return total;
}
