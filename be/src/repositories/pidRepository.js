import { db as defaultDb } from '../config/database.js';
import { createCrudRepository } from './baseRepository.js';
import { SqlWhere } from '../utils/sql.js';
import { applyScope } from '../middleware/scopeMiddleware.js';

// AGENCY_USER sees a PID when it is on one of the agency's master routes, or in one of the agency's
// daily assignment snapshots (GUIDE #4 A2). No agency column on pids.
export const pidAgencyScope = (p) => `EXISTS (SELECT 1 FROM route_pids rp JOIN routes r ON r.id = rp.route_id
                     WHERE rp.pid_id = p.id AND r.agency_id = ${p})
         OR EXISTS (SELECT 1 FROM route_assignment_pids rap JOIN route_assignments ra ON ra.id = rap.route_assignment_id
                     WHERE rap.pid_id = p.id AND ra.agency_id = ${p})`;

export const PID_SCOPE = { zone: 'p.zone_id', ward: 'p.ward_id', agency: pidAgencyScope };

const routeFilter = (where, routeId) =>
  where.add('EXISTS (SELECT 1 FROM route_pids rpf WHERE rpf.pid_id = p.id AND rpf.route_id = ?)', routeId);

const crud = createCrudRepository({
  table: 'pids',
  alias: 'p',
  select: `p.id, p.pid_number, p.owner_name, p.mobile, p.address, p.zone_id, z.zone_name, p.ward_id,
           w.ward_name, w.ward_number, p.latitude, p.longitude, p.coord_status, p.status,
           (SELECT count(*) FROM route_pids rpc WHERE rpc.pid_id = p.id) AS route_count,
           p.created_at, p.updated_at`,
  from: `pids p JOIN zones z ON z.id = p.zone_id JOIN wards w ON w.id = p.ward_id`,
  writable: ['pid_number', 'owner_name', 'mobile', 'address', 'zone_id', 'ward_id', 'latitude', 'longitude',
    'coord_status', 'status'],
  search: ['p.pid_number', 'p.address'],
  filters: {
    status: 'p.status',
    zone_id: 'p.zone_id',
    ward_id: 'p.ward_id',
    coord_status: 'p.coord_status',
    route_id: routeFilter,
    has_coords: (where, v) => where.add(v ? 'p.latitude IS NOT NULL' : 'p.latitude IS NULL'),
  },
  scope: PID_SCOPE,
  orderBy: 'p.pid_number ASC',
});

/** SQL + params for the lightweight map query (also used by the perf script for EXPLAIN). */
export function buildMapQuery({ bbox, zone_id, ward_id, route_id, limit, scope }) {
  const where = applyScope(new SqlWhere(), scope, PID_SCOPE);
  // Range predicates on (latitude, longitude) use idx_pids_lat_lng (partial: latitude IS NOT NULL).
  where.add('p.latitude BETWEEN ? AND ?', bbox.minLat, bbox.maxLat);
  where.add('p.longitude BETWEEN ? AND ?', bbox.minLng, bbox.maxLng);
  where.add("p.status = 'ACTIVE'");
  where.eq('p.zone_id', zone_id);
  where.eq('p.ward_id', ward_id);
  if (route_id) routeFilter(where, route_id);
  const limitP = where.param(limit + 1); // one extra row tells us whether the result was truncated
  return {
    text: `SELECT p.id, p.pid_number, p.latitude, p.longitude, p.coord_status FROM pids p ${where.toSql()} LIMIT ${limitP}`,
    values: where.params,
  };
}

export const pidRepository = {
  ...crud,

  async mapPoints(opts, executor = defaultDb) {
    const q = buildMapQuery(opts);
    const { rows } = await executor.query(q.text, q.values);
    const truncated = rows.length > opts.limit;
    return { points: truncated ? rows.slice(0, opts.limit) : rows, truncated };
  },

  /** Route wards a PID currently belongs to (for ward-change consistency checks). */
  async routeWardsForPid(pidId, executor = defaultDb) {
    const { rows } = await executor.query(
      `SELECT r.id, r.route_code, r.ward_id FROM route_pids rp JOIN routes r ON r.id = rp.route_id WHERE rp.pid_id = $1`,
      [pidId],
    );
    return rows;
  },
};
