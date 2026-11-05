// Date-wise route assignments with immutable PID snapshots (GUIDE #4 D, flow.txt §9, §22).
import { env } from '../config/env.js';
import { db as defaultDb, withTransaction } from '../config/database.js';
import { recordActivity } from './activityLogService.js';
import { AppError, conflict, forbidden, notFound, unprocessable, badRequest } from '../utils/errors.js';
import { SqlWhere, paginationMeta } from '../utils/sql.js';
import { applyScope } from '../middleware/scopeMiddleware.js';
import { todayInTz, daysBetween } from '../utils/time.js';
import { normaliseIp } from '../repositories/activityLogRepository.js';

const TZ = env.APP_TIMEZONE;
export const RA_SCOPE = { zone: 'r.zone_id', ward: 'r.ward_id', agency: 'ra.agency_id' };
export const COVERED_STATUS = 'GPS_VISIT_CONFIRMED';

const RA_SELECT = `ra.id, ra.operational_date::text AS operational_date, ra.shift_start, ra.shift_end, ra.status,
  ra.route_id, r.route_code, r.route_name, r.zone_id, z.zone_name, r.ward_id, w.ward_name,
  ra.vehicle_id, v.vehicle_number, ra.agency_id, a.agency_name, ra.assigned_pid_count,
  (SELECT count(*) FROM pid_daily_status s WHERE s.route_assignment_id = ra.id AND s.visit_status = '${COVERED_STATUS}') AS covered_pid_count,
  ra.assigned_by, ra.created_at, ra.updated_at`;
const RA_FROM = `route_assignments ra
  JOIN routes r   ON r.id = ra.route_id
  JOIN zones z    ON z.id = r.zone_id
  JOIN wards w    ON w.id = r.ward_id
  JOIN vehicles v ON v.id = ra.vehicle_id
  LEFT JOIN agencies a ON a.id = ra.agency_id`;

async function findAssignment(id, scope, executor = defaultDb) {
  const where = applyScope(new SqlWhere(), scope, RA_SCOPE).add('ra.id = ?', id);
  const { rows } = await executor.query(`SELECT ${RA_SELECT} FROM ${RA_FROM} ${where.toSql()}`, where.params);
  return rows[0] || null;
}

/** Duplicate (same route+vehicle+date, live) is a distinct, recognisable 409 for bulk "skipped_duplicate". */
class DuplicateAssignmentError extends AppError {
  constructor() {
    super(409, 'An assignment for this route, vehicle and date already exists');
    this.duplicate = true;
  }
}

/** Rebuild snapshot rows + pre-created daily statuses; returns snapshot size. */
async function snapshotPids(tx, assignment) {
  await tx.query(
    `INSERT INTO route_assignment_pids (route_assignment_id, pid_id, pid_latitude, pid_longitude)
     SELECT $1, p.id, p.latitude, p.longitude
       FROM route_pids rp JOIN pids p ON p.id = rp.pid_id
      WHERE rp.route_id = $2 AND p.status = 'ACTIVE'`,
    [assignment.id, assignment.route_id],
  );
  const res = await tx.query(
    `INSERT INTO pid_daily_status (operational_date, route_assignment_id, pid_id, vehicle_id, visit_status)
     SELECT $2::date, rap.route_assignment_id, rap.pid_id, $3,
            CASE WHEN rap.pid_latitude IS NULL THEN 'GPS_DATA_UNAVAILABLE' ELSE 'NOT_VISITED' END
       FROM route_assignment_pids rap WHERE rap.route_assignment_id = $1`,
    [assignment.id, assignment.operational_date, assignment.vehicle_id],
  );
  const count = res.rowCount;
  if (count === 0) throw unprocessable('Route has no active PIDs; add PIDs to the route before assigning it');
  await tx.query('UPDATE route_assignments SET assigned_pid_count = $2 WHERE id = $1', [assignment.id, count]);
  return count;
}

/**
 * Core create, run inside a caller-provided transaction (single create or one bulk savepoint).
 * input: { route_id, vehicle_id, operational_date, shift_start?, shift_end?, allow_past? }
 */
async function createInTx(tx, input, ctx) {
  const { route_id: routeId, vehicle_id: vehicleId, operational_date: opDate } = input;

  const shiftStart = input.shift_start ?? null;
  const shiftEnd = input.shift_end ?? null;

  // Date rule first (no DB needed).
  if (opDate < todayInTz(TZ)) {
    if (!input.allow_past) {
      throw unprocessable('Operational date is in the past', [{ field: 'operational_date', message: `Must be today (${todayInTz(TZ)}) or later` }]);
    }
    if (ctx.user?.role_key !== 'SUPER_ADMIN') throw forbidden('Only a super admin can create past-dated assignments');
  }

  // Round trip 1: lock the vehicle row (serialises concurrent assignments of the same vehicle) and
  // fetch the route, applying the caller's scope to the route in the join condition.
  const q1 = new SqlWhere();
  const vP = q1.param(vehicleId);
  const rP = q1.param(routeId);
  applyScope(q1, ctx.scope, { zone: 'r.zone_id', ward: 'r.ward_id', agency: 'r.agency_id' });
  const routeOn = [`r.id = ${rP}`, ...q1.clauses].join(' AND ');
  const head = (await tx.query(
    `SELECT v.status AS vehicle_status, v.agency_id AS vehicle_agency_id,
            r.id AS route_id, r.status AS route_status, r.agency_id AS route_agency_id
       FROM vehicles v LEFT JOIN routes r ON ${routeOn}
      WHERE v.id = ${vP} FOR UPDATE OF v`,
    q1.params,
  )).rows[0];
  if (!head) throw unprocessable('Vehicle not found', [{ field: 'vehicle_id', message: 'Unknown vehicle' }]);
  if (!head.route_id) throw unprocessable('Route not found', [{ field: 'route_id', message: 'Unknown route' }]);
  if (head.route_status !== 'ACTIVE') throw unprocessable('Route is not active', [{ field: 'route_id', message: 'Route is inactive' }]);
  if (head.vehicle_status !== 'ACTIVE') throw unprocessable('Vehicle is not active', [{ field: 'vehicle_id', message: `Vehicle status is ${head.vehicle_status}` }]);

  // Round trip 2: shift-window bounds, duplicate check and overlap / all-day conflicts in one query.
  // Windowed overlap is checked across ALL dates: a midnight-crossing shift can collide with the
  // next day's morning shift.
  const checks = (await tx.query(
    `SELECT
       EXISTS (SELECT 1 FROM route_assignments
                WHERE route_id = $1 AND vehicle_id = $2 AND operational_date = $3::date AND status <> 'CANCELLED') AS duplicate,
       ($4::timestamptz IS NULL OR ($4::timestamptz >= ($3::date::timestamp AT TIME ZONE $6)
          AND $5::timestamptz <= (($3::date + 1)::timestamp + interval '12 hours') AT TIME ZONE $6)) AS inside,
       ($3::date::timestamp AT TIME ZONE $6) AS win_start,
       (($3::date + 1)::timestamp + interval '12 hours') AT TIME ZONE $6 AS win_end,
       CASE WHEN $4::timestamptz IS NULL THEN
         (SELECT json_agg(json_build_object('id', ra.id, 'route_code', r.route_code, 'operational_date', ra.operational_date))
            FROM route_assignments ra JOIN routes r ON r.id = ra.route_id
           WHERE ra.vehicle_id = $2 AND ra.operational_date = $3::date AND ra.status <> 'CANCELLED' AND ra.shift_start IS NULL)
       ELSE
         (SELECT json_agg(json_build_object('id', ra.id, 'route_code', r.route_code, 'operational_date', ra.operational_date))
            FROM route_assignments ra JOIN routes r ON r.id = ra.route_id
           WHERE ra.vehicle_id = $2 AND ra.status <> 'CANCELLED' AND ra.shift_start IS NOT NULL
             AND ra.shift_start < $5::timestamptz AND ra.shift_end > $4::timestamptz)
       END AS conflicts`,
    [routeId, vehicleId, opDate, shiftStart, shiftEnd, TZ],
  )).rows[0];
  if (!checks.inside) {
    throw unprocessable('Shift must fall within the operational day (00:00 to next day 12:00, operational timezone)', [
      { field: 'shift_start', message: `Allowed window: ${checks.win_start.toISOString()} – ${checks.win_end.toISOString()}` },
    ]);
  }
  if (checks.duplicate) throw new DuplicateAssignmentError();
  if (checks.conflicts?.length) {
    const c = checks.conflicts;
    if (!shiftStart) {
      throw conflict('Vehicle already has an all-day assignment (no shift window) on this date', [
        { field: 'shift_start', message: `Existing all-day assignment ${c[0].id} (${c[0].route_code}); give one of them a shift window` },
      ]);
    }
    throw conflict('Shift overlaps another assignment of this vehicle', c.map((o) => ({
      field: 'shift_start', message: `Overlaps assignment ${o.id} (${o.route_code}, ${o.operational_date})`,
    })));
  }

  // Round trip 3: insert assignment + PID snapshot + pre-created daily statuses + audit row, atomically
  // in one statement. Agency snapshot = route's agency, else the vehicle's.
  const details = { route_id: routeId, vehicle_id: vehicleId, operational_date: opDate, shift_start: shiftStart, shift_end: shiftEnd };
  let created;
  try {
    created = (await tx.query(
      `WITH ins AS (
         INSERT INTO route_assignments (route_id, vehicle_id, agency_id, operational_date, shift_start, shift_end, assigned_by, assigned_pid_count)
         VALUES ($1, $2, $3, $4::date, $5::timestamptz, $6::timestamptz, $7::bigint,
                 (SELECT count(*) FROM route_pids rp JOIN pids p ON p.id = rp.pid_id WHERE rp.route_id = $1 AND p.status = 'ACTIVE'))
         RETURNING id, assigned_pid_count),
       snap AS (
         INSERT INTO route_assignment_pids (route_assignment_id, pid_id, pid_latitude, pid_longitude)
         SELECT ins.id, p.id, p.latitude, p.longitude
           FROM ins JOIN route_pids rp ON rp.route_id = $1 JOIN pids p ON p.id = rp.pid_id AND p.status = 'ACTIVE'
         RETURNING route_assignment_id, pid_id, pid_latitude),
       st AS (
         INSERT INTO pid_daily_status (operational_date, route_assignment_id, pid_id, vehicle_id, visit_status)
         SELECT $4::date, s.route_assignment_id, s.pid_id, $2,
                CASE WHEN s.pid_latitude IS NULL THEN 'GPS_DATA_UNAVAILABLE' ELSE 'NOT_VISITED' END
           FROM snap s
         RETURNING 1),
       log AS (
         INSERT INTO activity_logs (user_id, action, module, reference_id, details, ip_address)
         SELECT $7::bigint, 'CREATE', 'route_assignments', ins.id::text,
                $8::jsonb || jsonb_build_object('assigned_pid_count', ins.assigned_pid_count), $9::inet
           FROM ins)
       SELECT ins.id, ins.assigned_pid_count FROM ins`,
      [routeId, vehicleId, head.route_agency_id ?? head.vehicle_agency_id, opDate, shiftStart, shiftEnd,
        ctx.user?.id ?? null, details, normaliseIp(ctx.ip)],
    )).rows[0];
  } catch (err) {
    if (err.code === '23505') throw new DuplicateAssignmentError();
    throw err;
  }
  // Zero PIDs: throwing rolls back the whole statement (or the bulk item's savepoint).
  if (created.assigned_pid_count === 0) throw unprocessable('Route has no active PIDs; add PIDs to the route before assigning it');
  return created.id;
}

async function eventCount(tx, id) {
  return (await tx.query('SELECT count(*) AS n FROM pid_visit_events WHERE route_assignment_id = $1', [id])).rows[0].n;
}

async function lockAssignment(tx, id, scope) {
  const visible = await findAssignment(id, scope, tx);
  if (!visible) throw notFound('Route assignment not found');
  const { rows } = await tx.query('SELECT id, route_id, vehicle_id, operational_date::text AS operational_date, status FROM route_assignments WHERE id = $1 FOR UPDATE', [id]);
  return rows[0];
}

export const routeAssignmentService = {
  async create(input, ctx) {
    const id = await withTransaction((tx) => createInTx(tx, input, ctx));
    return findAssignment(id, null);
  },

  /** Each item in its own SAVEPOINT: one failure never rolls back the others. */
  async bulk(body, ctx) {
    let items;
    if (body.copy_from_date) {
      const where = applyScope(new SqlWhere(), ctx.scope, RA_SCOPE)
        .add('ra.operational_date = ?', body.copy_from_date)
        .add("ra.status <> 'CANCELLED'");
      where.eq('r.zone_id', body.zone_id);
      where.eq('r.ward_id', body.ward_id);
      const diff = daysBetween(body.copy_from_date, body.to_date);
      const dP = where.param(diff);
      const { rows } = await defaultDb.query(
        `SELECT ra.id AS source_id, ra.route_id, ra.vehicle_id,
                ra.shift_start + make_interval(days => ${dP}::int) AS shift_start,
                ra.shift_end   + make_interval(days => ${dP}::int) AS shift_end
           FROM route_assignments ra JOIN routes r ON r.id = ra.route_id ${where.toSql()} ORDER BY ra.id`,
        where.params,
      );
      if (rows.length > 500) throw unprocessable(`Source date has ${rows.length} assignments; bulk copy supports at most 500`);
      items = rows.map((r) => ({
        source_id: r.source_id, route_id: r.route_id, vehicle_id: r.vehicle_id, operational_date: body.to_date,
        shift_start: r.shift_start?.toISOString() ?? null, shift_end: r.shift_end?.toISOString() ?? null,
        allow_past: body.allow_past,
      }));
    } else {
      items = body.assignments;
    }

    const results = await withTransaction(async (tx) => {
      const out = [];
      /* eslint-disable no-await-in-loop -- savepoints must run sequentially on one connection */
      for (const [index, item] of items.entries()) {
        await tx.query('SAVEPOINT bulk_item');
        try {
          const id = await createInTx(tx, item, ctx);
          await tx.query('RELEASE SAVEPOINT bulk_item');
          out.push({ index, ...pickKeys(item), result: 'created', id });
        } catch (err) {
          await tx.query('ROLLBACK TO SAVEPOINT bulk_item');
          if (!(err instanceof AppError) && !err.code) throw err; // unexpected bug: abort the whole batch
          out.push({ index, ...pickKeys(item), result: err.duplicate ? 'skipped_duplicate' : 'error', message: err.message, errors: err.errors });
        }
      }
      /* eslint-enable no-await-in-loop */
      return out;
    });

    const summary = {
      total: results.length,
      created: results.filter((r) => r.result === 'created').length,
      skipped_duplicate: results.filter((r) => r.result === 'skipped_duplicate').length,
      error: results.filter((r) => r.result === 'error').length,
    };
    return { summary, results };
  },

  async list(q, scope) {
    const where = applyScope(new SqlWhere(), scope, RA_SCOPE);
    if (q.date_from || q.date_to) {
      const from = q.date_from ?? q.date_to;
      const to = q.date_to ?? q.date_from;
      if (to < from) throw badRequest('date_to must be on or after date_from');
      if (daysBetween(from, to) > 30) throw badRequest('Date range may span at most 31 days');
      where.add('ra.operational_date BETWEEN ? AND ?', from, to);
    } else {
      where.add('ra.operational_date = ?', q.operational_date ?? todayInTz(TZ));
    }
    where.eq('ra.vehicle_id', q.vehicle_id);
    where.eq('ra.route_id', q.route_id);
    where.eq('r.zone_id', q.zone_id);
    where.eq('r.ward_id', q.ward_id);
    where.eq('ra.agency_id', q.agency_id);
    where.eq('ra.status', q.status);
    where.search(['r.route_code', 'r.route_name', 'v.vehicle_number'], q.search);
    const whereSql = where.toSql();
    const total = (await defaultDb.query(`SELECT count(*) AS total FROM ${RA_FROM} ${whereSql}`, where.params)).rows[0].total;
    const lp = where.param(q.limit);
    const op = where.param((q.page - 1) * q.limit);
    const { rows } = await defaultDb.query(
      `SELECT ${RA_SELECT} FROM ${RA_FROM} ${whereSql} ORDER BY ra.operational_date DESC, r.route_code, v.vehicle_number LIMIT ${lp} OFFSET ${op}`,
      where.params,
    );
    return { rows, pagination: paginationMeta(q.page, q.limit, total) };
  },

  async get(id, q, scope) {
    const assignment = await findAssignment(id, scope);
    if (!assignment) throw notFound('Route assignment not found');
    const where = new SqlWhere().add('rap.route_assignment_id = ?', id);
    where.eq('s.visit_status', q.visit_status);
    const whereSql = where.toSql();
    const from = `route_assignment_pids rap
        JOIN pids p ON p.id = rap.pid_id
        LEFT JOIN pid_daily_status s ON s.route_assignment_id = rap.route_assignment_id AND s.pid_id = rap.pid_id`;
    const total = (await defaultDb.query(`SELECT count(*) AS total FROM ${from} ${whereSql}`, where.params)).rows[0].total;
    const lp = where.param(q.limit);
    const op = where.param((q.page - 1) * q.limit);
    const { rows } = await defaultDb.query(
      `SELECT rap.pid_id, p.pid_number, p.address, rap.pid_latitude, rap.pid_longitude,
              s.visit_status, s.first_visit_at, s.last_visit_at, s.detection_count, s.min_distance_meters
         FROM ${from} ${whereSql}
        ORDER BY p.pid_number LIMIT ${lp} OFFSET ${op}`,
      where.params,
    );
    return { ...assignment, pids: rows, pids_pagination: paginationMeta(q.page, q.limit, total) };
  },

  async cancel(id, ctx) {
    await withTransaction(async (tx) => {
      const ra = await lockAssignment(tx, id, ctx.scope);
      const events = await eventCount(tx, id);
      const allowed = ra.status === 'PLANNED' || (ra.status === 'ACTIVE' && events === 0);
      if (!allowed) {
        throw conflict(ra.status === 'ACTIVE' ? 'Assignment already has GPS activity and cannot be cancelled' : `Assignment is ${ra.status} and cannot be cancelled`);
      }
      await tx.query("UPDATE route_assignments SET status = 'CANCELLED' WHERE id = $1", [id]);
      await recordActivity(ctx, { action: 'CANCEL', module: 'route_assignments', referenceId: id, details: { previous_status: ra.status } }, tx);
    });
    return findAssignment(id, null);
  },

  async resnapshot(id, ctx) {
    await withTransaction(async (tx) => {
      const ra = await lockAssignment(tx, id, ctx.scope);
      if (ra.status !== 'PLANNED' || (await eventCount(tx, id)) > 0) {
        throw conflict('Assignment already has GPS activity (or is no longer PLANNED); its PID snapshot is frozen');
      }
      const before = (await tx.query('SELECT assigned_pid_count FROM route_assignments WHERE id = $1', [id])).rows[0].assigned_pid_count;
      await tx.query('DELETE FROM pid_daily_status WHERE route_assignment_id = $1', [id]);
      await tx.query('DELETE FROM route_assignment_pids WHERE route_assignment_id = $1', [id]);
      const count = await snapshotPids(tx, ra);
      await recordActivity(ctx, { action: 'RESNAPSHOT', module: 'route_assignments', referenceId: id, details: { before, after: count } }, tx);
    });
    return findAssignment(id, null);
  },
};

function pickKeys(item) {
  const { source_id, route_id, vehicle_id, operational_date } = item;
  return source_id ? { source_id, route_id, vehicle_id, operational_date } : { route_id, vehicle_id, operational_date };
}
