// PID visit detection engine (flow.txt §8, GUIDE #7). Set-based: one batch =
//   BEGIN · Q1 (claim + resolve + gate + candidates + events + mark processed) · Q2 (recompute statuses) · COMMIT
// = 4 round trips, whatever the batch size. Idempotent: events are ON CONFLICT DO NOTHING and daily
// statuses are recomputed from ALL events of each affected (assignment, PID) pair — never incremented.
import { gpsEvents } from './gps/gpsEvents.js';
import { M_PER_DEG_LAT, MIN_COS_LAT } from '../utils/haversine.js';

export const DEFAULT_BATCH_SIZE = 5000;

// ---------------------------------------------------------------- Q1: claim + events
// $1 batch size · $2 tz · $3 radius m · $4 max age s · $5 policy · $6 min speed · $7 max speed
// $8 metres/deg-lat · $9 min cos(lat) · $10 segment evidence on · $11 segment max length m · $12 max gap s
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
  -- n = PIDs within radius of this point (ambiguity), as a window count: never join this CTE to an
  -- aggregate of itself (1-row CTE estimates turn that into a quadratic nested loop).
  SELECT g.id AS gps_id, g.vehicle_id, g.ra_id, g.recorded_at, g.speed, g.lat AS gps_lat, g.lng AS gps_lng, g.evidence, c.pid_id, c.dist,
         count(*) OVER (PARTITION BY g.id, g.ra_id)::int AS n
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
-- ---- TRACK_SEGMENT evidence (GUIDE #8): the line between two strictly adjacent, valid points of the
-- same vehicle and assignment (gap ≤ $12 s, length ≤ $11 m). For each valid batch point, its previous
-- point AND (for late arrivals) its next point; the event belongs to the LATER point of the pair.
nbr AS (
  SELECT g.ra_id, g.vehicle_id, g.id AS g_id, g.recorded_at AS g_at, g.lat AS g_lat, g.lng AS g_lng, g.speed AS g_speed,
         n.dir, n.id AS n_id, n.recorded_at AS n_at, n.lat AS n_lat, n.lng AS n_lng, n.speed AS n_speed, n.received_at AS n_received
    FROM gated g
    CROSS JOIN LATERAL (
      -- Bounded by the max segment gap ($12): a neighbour further away can never form a segment, and the
      -- bound lets the planner prune gps_locations partitions per probe (GUIDE #11 A).
      (SELECT 'prev' AS dir, q.id, q.recorded_at, q.latitude::float8 AS lat, q.longitude::float8 AS lng, q.speed, q.received_at
         FROM gps_locations q WHERE q.vehicle_id = g.vehicle_id AND q.recorded_at < g.recorded_at
          AND q.recorded_at >= g.recorded_at - make_interval(secs => $12::int)
        ORDER BY q.recorded_at DESC LIMIT 1)
      UNION ALL
      (SELECT 'next', q.id, q.recorded_at, q.latitude::float8, q.longitude::float8, q.speed, q.received_at
         FROM gps_locations q WHERE q.vehicle_id = g.vehicle_id AND q.recorded_at > g.recorded_at
          AND q.recorded_at <= g.recorded_at + make_interval(secs => $12::int)
        ORDER BY q.recorded_at ASC LIMIT 1)
    ) n
   WHERE $10::boolean AND g.evidence = 'PROXIMITY_POINT'
),
segs AS (
  SELECT ra_id, vehicle_id,
         CASE WHEN dir = 'prev' THEN g_id ELSE n_id END    AS later_id,
         CASE WHEN dir = 'prev' THEN g_at ELSE n_at END    AS later_at,
         CASE WHEN dir = 'prev' THEN g_speed ELSE n_speed END AS later_speed,
         CASE WHEN dir = 'prev' THEN g_lat ELSE n_lat END  AS later_lat,
         CASE WHEN dir = 'prev' THEN g_lng ELSE n_lng END  AS later_lng,
         n_lat AS a_lat, n_lng AS a_lng, g_lat AS b_lat, g_lng AS b_lng
    FROM nbr x
   WHERE abs(extract(epoch FROM x.g_at - x.n_at)) <= $12::int
     AND haversine_m(x.n_lat, x.n_lng, x.g_lat, x.g_lng) <= $11::float8
     -- the neighbour must be valid under the same gates ...
     AND NOT ($5 = 'evidence_only' AND x.n_received - x.n_at > make_interval(secs => $4::int))
     AND NOT (x.n_speed IS NOT NULL AND (($6::numeric IS NOT NULL AND x.n_speed < $6::numeric) OR ($7::numeric IS NOT NULL AND x.n_speed > $7::numeric)))
     -- ... and resolve to the same assignment
     AND (SELECT y.id FROM route_assignments y
           WHERE y.vehicle_id = x.vehicle_id AND y.status <> 'CANCELLED'
             AND ((y.shift_start IS NOT NULL AND x.n_at >= y.shift_start AND x.n_at < y.shift_end)
                  OR (y.shift_start IS NULL AND y.operational_date = (x.n_at AT TIME ZONE $2)::date))
           ORDER BY (y.shift_start IS NOT NULL) DESC, y.id LIMIT 1) = x.ra_id
),
seg_dedup AS (
  -- PIDs within radius of the segment INTERIOR only: if either endpoint is within radius, point evidence
  -- already covers it (and the unique key would collide).
  SELECT DISTINCT ON (s.later_id, s.ra_id, c.pid_id)
         s.later_id AS gps_id, s.vehicle_id, s.ra_id, s.later_at AS recorded_at, s.later_speed AS speed,
         s.later_lat AS gps_lat, s.later_lng AS gps_lng, 'TRACK_SEGMENT'::text AS evidence, c.pid_id, c.dist
    FROM segs s
    CROSS JOIN LATERAL (
      SELECT rap.pid_id,
             seg_dist_m(rap.pid_latitude::float8, rap.pid_longitude::float8, s.a_lat, s.a_lng, s.b_lat, s.b_lng) AS dist,
             haversine_m(rap.pid_latitude::float8, rap.pid_longitude::float8, s.a_lat, s.a_lng) AS da,
             haversine_m(rap.pid_latitude::float8, rap.pid_longitude::float8, s.b_lat, s.b_lng) AS db
        FROM route_assignment_pids rap
       WHERE rap.route_assignment_id = s.ra_id
         AND rap.pid_latitude  BETWEEN (least(s.a_lat, s.b_lat) - $3::float8 / $8::float8 * 1.01)::numeric
                                   AND (greatest(s.a_lat, s.b_lat) + $3::float8 / $8::float8 * 1.01)::numeric
         AND rap.pid_longitude BETWEEN (least(s.a_lng, s.b_lng) - $3::float8 / ($8::float8 * greatest(cos(radians(s.a_lat)), $9::float8)) * 1.01)::numeric
                                   AND (greatest(s.a_lng, s.b_lng) + $3::float8 / ($8::float8 * greatest(cos(radians(s.a_lat)), $9::float8)) * 1.01)::numeric
      OFFSET 0
    ) c
   WHERE c.dist <= $3::float8 AND c.da > $3::float8 AND c.db > $3::float8
   ORDER BY s.later_id, s.ra_id, c.pid_id, c.dist
),
seg_cand AS (
  SELECT d.*, count(*) OVER (PARTITION BY d.gps_id, d.ra_id)::int AS n FROM seg_dedup d
),
ins AS (
  -- gps_* = self-contained copy of the point (GUIDE #11 A): evidence survives raw-GPS partition retention.
  INSERT INTO pid_visit_events (route_assignment_id, pid_id, vehicle_id, gps_location_id, distance_meters,
                                speed_at_detection, detected_at, evidence_status, ambiguous, pids_in_radius,
                                gps_recorded_at, gps_latitude, gps_longitude, gps_speed)
  SELECT ra_id, pid_id, vehicle_id, gps_id, round(dist::numeric, 2), speed, recorded_at, evidence, n >= 2, n,
         recorded_at, round(gps_lat::numeric, 7), round(gps_lng::numeric, 7), speed FROM cand
  UNION ALL
  SELECT ra_id, pid_id, vehicle_id, gps_id, round(dist::numeric, 2), speed, recorded_at, evidence, n >= 2, n,
         recorded_at, round(gps_lat::numeric, 7), round(gps_lng::numeric, 7), speed FROM seg_cand
  ON CONFLICT (route_assignment_id, pid_id, gps_location_id) DO NOTHING
  RETURNING id
),
touched AS (
  SELECT DISTINCT ra_id, pid_id FROM (SELECT ra_id, pid_id FROM cand UNION ALL SELECT ra_id, pid_id FROM seg_cand) u
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
  -- (id, recorded_at) pkey per partition; the recorded_at bounds of the batch prune partitions at run time.
  UPDATE gps_locations SET processed_at = now()
   WHERE id = ANY ((SELECT array_agg(id) FROM batch)::bigint[])
     AND recorded_at >= (SELECT min(recorded_at) FROM batch) AND recorded_at <= (SELECT max(recorded_at) FROM batch)
  RETURNING id
)
SELECT (SELECT count(*) FROM batch)::int                       AS points,
       (SELECT count(*) FROM asg WHERE ra_id IS NULL)::int      AS unassigned_points,
       (SELECT count(*) FROM gated WHERE evidence <> 'PROXIMITY_POINT')::int AS rejected_points,
       (SELECT count(*) FROM ins)::int                          AS events_inserted,
       (SELECT count(*) FROM activate)::int                     AS assignments_activated,
       (SELECT count(*) FROM late_log)::int                     AS late_after_finalize,
       (SELECT count(*) FROM seg_cand)::int                     AS segment_candidates,
       COALESCE((SELECT array_agg(ra_id ORDER BY ra_id, pid_id) FROM touched), '{}') AS pair_ra,
       COALESCE((SELECT array_agg(pid_id ORDER BY ra_id, pid_id) FROM touched), '{}') AS pair_pid`;

// ---------------------------------------------------------------- Q2: recompute statuses
// $1 ra ids · $2 pid ids · $3 mode · $4 N · $5 window s · $6 dwell s
// Status rank: CONFIRMED 3 > CANDIDATE 2 > others 1 — a recompute never lowers a status.
export const RECOMPUTE_SQL = `
WITH pairs AS (
  SELECT DISTINCT * FROM unnest($1::bigint[], $2::bigint[]) AS p(ra_id, pid_id)
),
evid AS MATERIALIZED (
  -- All non-rejected evidence of each pair. One index probe per pair on (route_assignment_id, pid_id, …):
  -- OFFSET 0 stops the planner from flattening this into a hash join over the ever-growing events table.
  SELECT p.ra_id, p.pid_id, e.id, e.vehicle_id, e.detected_at, e.distance_meters, e.ambiguous,
         e.evidence_status = 'TRACK_SEGMENT' AS is_seg
    FROM pairs p
    CROSS JOIN LATERAL (
      SELECT x.id, x.vehicle_id, x.detected_at, x.distance_meters, x.ambiguous, x.evidence_status
        FROM pid_visit_events x
       WHERE x.route_assignment_id = p.ra_id AND x.pid_id = p.pid_id
         AND x.evidence_status IN ('PROXIMITY_POINT', 'TRACK_SEGMENT')
      OFFSET 0) e
),
valid AS (
  -- Only GPS point fixes take part in confirmation (TRACK_SEGMENT never confirms, never counts towards N).
  SELECT ra_id, pid_id, id, vehicle_id, detected_at, distance_meters, ambiguous FROM evid WHERE NOT is_seg
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
point_comp AS (
  -- Level 2 (points): one row per pair with the confirmation verdict.
  SELECT ra_id, pid_id, min(first_at) AS first_at, max(last_at) AS last_at, sum(n)::int AS cnt,
         min(min_d) AS min_d, bool_or(any_amb) AS any_amb,
         (array_agg(best_id ORDER BY min_d, first_at, best_id))[1] AS best_id,
         COALESCE(CASE $3
                    WHEN 'consecutive_points' THEN max(n) >= $4::int
                    WHEN 'min_events' THEN max(max_win) >= $4::int
                    WHEN 'dwell' THEN max(extract(epoch FROM last_at - first_at)) >= $6::int
                  END, false) AS confirmed,
         0 AS seg_rank
    FROM per_island GROUP BY ra_id, pid_id
),
seg_comp AS (
  -- TRACK_SEGMENT evidence: contributes to first/last/count/distance and makes a pair at most CANDIDATE.
  SELECT ra_id, pid_id, min(detected_at) AS first_at, max(detected_at) AS last_at, count(*)::int AS cnt,
         min(distance_meters) AS min_d, bool_or(ambiguous) AS any_amb,
         (array_agg(id ORDER BY distance_meters, detected_at, id))[1] AS best_id,
         false AS confirmed, 1 AS seg_rank
    FROM evid WHERE is_seg GROUP BY ra_id, pid_id
),
computed AS (
  -- Combine both sources in ONE aggregation (no joins between aggregates — those were planned as
  -- quadratic nested loops over 1-row CTE estimates). best_event prefers a point fix over a segment.
  SELECT ra_id, pid_id, min(first_at) AS first_at, max(last_at) AS last_at, sum(cnt)::int AS cnt,
         min(min_d) AS min_d, bool_or(any_amb) AS any_amb,
         (array_agg(best_id ORDER BY seg_rank, min_d, best_id))[1] AS best_id,
         CASE WHEN bool_or(confirmed) THEN 'GPS_VISIT_CONFIRMED' ELSE 'GPS_VISIT_CANDIDATE' END AS new_status
    FROM (SELECT * FROM point_comp UNION ALL SELECT * FROM seg_comp) u
   GROUP BY ra_id, pid_id
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
      settings.segmentEvidenceEnabled !== false, settings.segmentMaxLengthM ?? 200, settings.segmentMaxGapS ?? 90,
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
