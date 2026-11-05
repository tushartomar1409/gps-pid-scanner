// Assigned route vs actual GPS route (flow.txt §12, GUIDE #8 D).
import { env } from '../config/env.js';
import { db as defaultDb } from '../config/database.js';
import { SqlWhere } from '../utils/sql.js';
import { applyScope } from '../middleware/scopeMiddleware.js';
import { notFound } from '../utils/errors.js';
import { buildHistoryQuery } from './gps/gpsReadService.js';
import { loadDetectionSettings } from './settingsDefinitions.js';
import { GPS_DISCLAIMER } from './dashboardService.js';

const RA_SCOPE = { zone: 'r.zone_id', ward: 'r.ward_id', agency: 'ra.agency_id' };
export const MAX_TRACK_POINTS = 2000;
export const RELIABLE_MIN_POINTS = 10;
export const RELIABLE_MAX_GAP_S = 600;
export const OUTLIER_SPEED_KMH = 120;
export const STATIONARY_KMH = 3;

/**
 * GPS route distance over FULL-resolution points:
 *  - skip a segment shorter than distance_min_segment_m whose implied speed is < 3 km/h (stationary jitter)
 *  - skip a segment whose implied speed is > 120 km/h (teleport / outlier: both segments around a bad point)
 * $1 vehicle · $2 from · $3 to · $4 min segment m
 */
export const DISTANCE_SQL = `
WITH p AS (
  SELECT recorded_at, latitude::float8 AS lat, longitude::float8 AS lng
    FROM gps_locations WHERE vehicle_id = $1 AND recorded_at >= $2 AND recorded_at < $3
),
s AS (
  SELECT recorded_at, lat, lng, lag(lat) OVER w AS plat, lag(lng) OVER w AS plng, lag(recorded_at) OVER w AS pat
    FROM p WINDOW w AS (ORDER BY recorded_at)
),
d AS (
  SELECT haversine_m(plat, plng, lat, lng) AS m, extract(epoch FROM recorded_at - pat) AS dt
    FROM s WHERE pat IS NOT NULL
),
k AS (SELECT m, dt, m / NULLIF(dt, 0) * 3.6 AS kmh FROM d)
SELECT (SELECT count(*) FROM p)::int AS points,
       (SELECT min(recorded_at) FROM p) AS first_at,
       (SELECT max(recorded_at) FROM p) AS last_at,
       COALESCE(sum(m) FILTER (WHERE NOT (m < $4::float8 AND kmh < ${STATIONARY_KMH}) AND kmh <= ${OUTLIER_SPEED_KMH}), 0)::float8 AS distance_m,
       count(*) FILTER (WHERE kmh > ${OUTLIER_SPEED_KMH})::int AS outlier_segments,
       count(*) FILTER (WHERE m < $4::float8 AND kmh < ${STATIONARY_KMH})::int AS jitter_segments,
       COALESCE(max(dt), 0)::float8 AS max_gap_s
  FROM k`;

/**
 * Deviation from the assigned line with PostGIS geography distance per point, then gaps-and-islands for
 * contiguous off-route runs (≤ 50 returned). $1 vehicle · $2 from · $3 to · $4 GeoJSON · $5 threshold m
 */
export const DEVIATION_SQL = `
WITH line AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($4::text), 4326)::geography AS g),
p AS (
  SELECT q.recorded_at,
         ST_Distance(ST_SetSRID(ST_MakePoint(q.longitude::float8, q.latitude::float8), 4326)::geography, line.g) AS d
    FROM gps_locations q, line
   WHERE q.vehicle_id = $1 AND q.recorded_at >= $2 AND q.recorded_at < $3
),
f AS (
  SELECT recorded_at, d, d > $5::float8 AS off,
         row_number() OVER (ORDER BY recorded_at) - row_number() OVER (PARTITION BY d > $5::float8 ORDER BY recorded_at) AS grp
    FROM p
),
runs AS (
  SELECT min(recorded_at) AS "from", max(recorded_at) AS "to", round(max(d)::numeric, 1)::float8 AS max_m, count(*)::int AS points
    FROM f WHERE off GROUP BY grp ORDER BY min(recorded_at) LIMIT 50
)
SELECT (SELECT count(*) FROM p)::int AS points,
       (SELECT count(*) FROM f WHERE off)::int AS points_off_route,
       COALESCE((SELECT round(max(d)::numeric, 1) FROM p), 0)::float8 AS max_deviation_m,
       (SELECT count(*) FROM (SELECT 1 FROM f WHERE off GROUP BY grp) x)::int AS off_route_segment_count,
       COALESCE((SELECT json_agg(runs ORDER BY "from") FROM runs), '[]') AS off_route_segments`;

export async function compareAssignment(id, scope, db = defaultDb) {
  const settings = await loadDetectionSettings(db);
  const where = applyScope(new SqlWhere(), scope, RA_SCOPE).add('ra.id = ?', id);
  const tzP = where.param(env.APP_TIMEZONE);
  const { rows: [a] } = await db.query(
    `SELECT ra.id, ra.vehicle_id, v.vehicle_number, ra.operational_date::text AS operational_date, ra.status,
            ra.route_id, r.route_code, r.route_name, r.route_geometry,
            COALESCE(ra.shift_start, (ra.operational_date::timestamp AT TIME ZONE ${tzP})) AS window_start,
            COALESCE(ra.shift_end, ((ra.operational_date + 1)::timestamp + interval '12 hours') AT TIME ZONE ${tzP}) AS window_end,
            c.*
       FROM route_assignments ra JOIN routes r ON r.id = ra.route_id JOIN vehicles v ON v.id = ra.vehicle_id
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS assigned,
                count(*) FILTER (WHERE s.visit_status = 'GPS_VISIT_CONFIRMED')::int AS confirmed,
                count(*) FILTER (WHERE s.visit_status = 'GPS_VISIT_CANDIDATE')::int AS candidate
           FROM pid_daily_status s WHERE s.route_assignment_id = ra.id) c
      ${where.toSql()}`, where.params);
  if (!a) throw notFound('Route assignment not found');

  const win = [a.vehicle_id, a.window_start, a.window_end];
  const hist = buildHistoryQuery(a.vehicle_id, a.window_start, new Date(a.window_end.getTime() - 1), MAX_TRACK_POINTS);
  const [track, dist, dev] = await Promise.all([
    db.query(hist.text, hist.values),
    db.query(DISTANCE_SQL, [...win, settings.distanceMinSegmentM]),
    a.route_geometry
      ? db.query(DEVIATION_SQL, [...win, JSON.stringify(a.route_geometry), settings.deviationThresholdM])
      : Promise.resolve(null),
  ]);
  const d = dist.rows[0];
  const reasons = [];
  if (d.points < RELIABLE_MIN_POINTS) reasons.push(`Only ${d.points} GPS points in the window (need ≥ ${RELIABLE_MIN_POINTS})`);
  if (d.max_gap_s > RELIABLE_MAX_GAP_S) reasons.push(`GPS gap of ${Math.round(d.max_gap_s / 60)} min (> ${RELIABLE_MAX_GAP_S / 60} min)`);
  const pct = (n) => (a.assigned ? Math.round((1000 * n) / a.assigned) / 10 : null);
  const total = Number(track.rows[0]?.total ?? 0);
  const dv = dev?.rows[0];

  return {
    route_assignment_id: a.id, operational_date: a.operational_date, status: a.status,
    route: { id: a.route_id, route_code: a.route_code, route_name: a.route_name },
    vehicle: { id: a.vehicle_id, vehicle_number: a.vehicle_number },
    window: { start: a.window_start, end: a.window_end },
    assigned_geometry: a.route_geometry ?? null,
    actual_track: {
      points: track.rows.map(({ total: _t, ...p }) => p), total_in_window: total, downsampled: total > MAX_TRACK_POINTS,
    },
    counts: {
      assigned: a.assigned, confirmed: a.confirmed, candidate: a.candidate, remaining: a.assigned - a.confirmed,
      confirmed_pct: pct(a.confirmed), detected_pct: pct(a.confirmed + a.candidate),
    },
    first_gps_activity: d.first_at, last_gps_activity: d.last_at,
    gps_route_distance_m: Math.round(d.distance_m),
    distance_quality: {
      reliable: reasons.length === 0, reasons,
      points: d.points, max_gap_s: Math.round(d.max_gap_s), jitter_segments_skipped: d.jitter_segments, outlier_segments_skipped: d.outlier_segments,
    },
    route_deviation: dv ? {
      threshold_m: settings.deviationThresholdM,
      points_off_route: dv.points_off_route,
      pct_off_route: dv.points ? Math.round((1000 * dv.points_off_route) / dv.points) / 10 : 0,
      max_deviation_m: dv.max_deviation_m,
      off_route_segment_count: dv.off_route_segment_count,
      off_route_segments: dv.off_route_segments,
    } : null,
    disclaimer: GPS_DISCLAIMER,
  };
}
