// Hand-made tracks for detection scenario tests.
import { pool } from '../../src/config/database.js';
import { offsetM } from '../../src/services/gps/geoMath.js';
import { loadDetectionSettings } from '../../src/services/settingsDefinitions.js';
import { runDetection } from '../../src/services/pidDetectionService.js';
import { createZoneWard, createVehicle, uid } from './fixtures.js';

export const ORIGIN = [28.5, 77.2];
/** A point `north` / `east` metres from ORIGIN (or from `from`). */
export const at = (north, east = 0, from = ORIGIN) => offsetM(from, north, east);
export const ist = (date, hhmmss) => new Date(`${date}T${hhmmss}+05:30`);

/**
 * Route + PIDs (absolute [lat,lng] list) + vehicle + assignment (+ snapshot + pre-created statuses).
 * pids: [[lat,lng] | null] — null = PID without coordinates (snapshot NULL).
 */
export async function makeAssignment({ pids, date, shift = null, vehicle = null, routeWard = null, existingPidIds = null }) {
  const zw = routeWard || (await createZoneWard());
  const v = vehicle || (await createVehicle());
  const route = (await pool.query(
    `INSERT INTO routes (route_code, route_name, zone_id, ward_id) VALUES ($1, 'Det', $2, $3) RETURNING id`,
    [`DR${uid()}`, zw.zone.id, zw.ward.id])).rows[0];
  let pidIds = existingPidIds;
  if (!pidIds) {
    pidIds = [];
    for (const p of pids) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        `INSERT INTO pids (pid_number, zone_id, ward_id, latitude, longitude, coord_status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [`DP${uid()}`, zw.zone.id, zw.ward.id, p?.[0] ?? null, p?.[1] ?? null, p ? 'IMPORTED' : 'MISSING']);
      pidIds.push(rows[0].id);
    }
  }
  await pool.query('INSERT INTO route_pids (route_id, pid_id, sequence_no) SELECT $1, id, ord FROM unnest($2::bigint[]) WITH ORDINALITY t(id, ord)', [route.id, pidIds]);
  const ra = (await pool.query(
    `INSERT INTO route_assignments (route_id, vehicle_id, operational_date, shift_start, shift_end, assigned_pid_count)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [route.id, v.id, date, shift?.[0] ?? null, shift?.[1] ?? null, pidIds.length])).rows[0];
  await pool.query(
    `INSERT INTO route_assignment_pids (route_assignment_id, pid_id, pid_latitude, pid_longitude)
     SELECT $1, p.id, p.latitude, p.longitude FROM pids p WHERE p.id = ANY($2)`, [ra.id, pidIds]);
  await pool.query(
    `INSERT INTO pid_daily_status (operational_date, route_assignment_id, pid_id, vehicle_id, visit_status)
     SELECT $1, rap.route_assignment_id, rap.pid_id, $3, CASE WHEN rap.pid_latitude IS NULL THEN 'GPS_DATA_UNAVAILABLE' ELSE 'NOT_VISITED' END
       FROM route_assignment_pids rap WHERE rap.route_assignment_id = $2`, [date, ra.id, v.id]);
  return { raId: ra.id, pidIds, vehicle: v, zw, routeId: route.id };
}

/** Insert a track: [{ p: [lat,lng], t: Date, speed?, delayS? (received_at - recorded_at, default 5) }] */
export async function track(vehicleId, points) {
  const cols = [[], [], [], [], [], []];
  for (const x of points) {
    cols[0].push(vehicleId); cols[1].push(x.p[0]); cols[2].push(x.p[1]); cols[3].push(x.speed ?? 10);
    cols[4].push(x.t); cols[5].push(new Date(x.t.getTime() + (x.delayS ?? 5) * 1000));
  }
  const { rows } = await pool.query(
    `INSERT INTO gps_locations (vehicle_id, device_id, latitude, longitude, speed, recorded_at, received_at, provider)
     SELECT v, 'TEST', la, lo, sp, ra, rc, 'test' FROM unnest($1::int[], $2::numeric[], $3::numeric[], $4::numeric[], $5::timestamptz[], $6::timestamptz[])
            AS t(v, la, lo, sp, ra, rc)
     RETURNING id`, cols);
  return rows.map((r) => Number(r.id));
}

export const BASE = { radiusM: 30, confirmationMode: 'consecutive_points', consecutivePoints: 2, minSpeedKmh: null, maxSpeedKmh: null, latePointsPolicy: 'evidence_only', maxGpsAgeS: 300 };

export async function detect(overrides = {}, opts = {}) {
  const settings = await loadDetectionSettings(pool, { ...BASE, ...overrides });
  return runDetection(pool, settings, opts);
}

export async function statuses(raId) {
  const { rows } = await pool.query(
    `SELECT pid_id, visit_status, detection_count, first_visit_at, last_visit_at, min_distance_meters, best_event_id, ambiguous, confirmed_at
       FROM pid_daily_status WHERE route_assignment_id = $1 ORDER BY pid_id`, [raId]);
  return Object.fromEntries(rows.map((r) => [r.pid_id, r]));
}

export async function events(raId) {
  const { rows } = await pool.query(
    'SELECT pid_id, gps_location_id, evidence_status, ambiguous, pids_in_radius, distance_meters FROM pid_visit_events WHERE route_assignment_id = $1 ORDER BY id', [raId]);
  return rows;
}
