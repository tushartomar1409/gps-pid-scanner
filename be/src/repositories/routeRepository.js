import { db as defaultDb } from '../config/database.js';
import { createCrudRepository } from './baseRepository.js';

export const ROUTE_SCOPE = { zone: 'r.zone_id', ward: 'r.ward_id', agency: 'r.agency_id' };

const crud = createCrudRepository({
  table: 'routes',
  alias: 'r',
  select: `r.id, r.route_code, r.route_name, r.zone_id, z.zone_name, r.ward_id, w.ward_name, w.ward_number,
           r.agency_id, a.agency_name, r.default_vehicle_id, v.vehicle_number AS default_vehicle_number,
           r.start_latitude, r.start_longitude, r.end_latitude, r.end_longitude, r.route_geometry, r.status,
           (SELECT count(*) FROM route_pids rp WHERE rp.route_id = r.id) AS pid_count,
           r.created_at, r.updated_at`,
  from: `routes r
         JOIN zones z ON z.id = r.zone_id
         JOIN wards w ON w.id = r.ward_id
         LEFT JOIN agencies a ON a.id = r.agency_id
         LEFT JOIN vehicles v ON v.id = r.default_vehicle_id`,
  writable: ['route_code', 'route_name', 'zone_id', 'ward_id', 'agency_id', 'default_vehicle_id',
    'start_latitude', 'start_longitude', 'end_latitude', 'end_longitude', 'route_geometry', 'status'],
  search: ['r.route_code', 'r.route_name'],
  filters: { status: 'r.status', zone_id: 'r.zone_id', ward_id: 'r.ward_id', agency_id: 'r.agency_id' },
  scope: ROUTE_SCOPE,
  orderBy: 'r.route_code ASC',
});

export const routeRepository = {
  ...crud,

  async lockById(id, executor) {
    const { rows } = await executor.query('SELECT id, ward_id, zone_id, status FROM routes WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] || null;
  },

  async listPids(routeId, { page, limit }, executor = defaultDb) {
    const [count, rows] = await Promise.all([
      executor.query('SELECT count(*) AS total FROM route_pids WHERE route_id = $1', [routeId]),
      executor.query(
        `SELECT p.id, p.pid_number, p.address, p.latitude, p.longitude, p.coord_status, p.status, rp.sequence_no
           FROM route_pids rp JOIN pids p ON p.id = rp.pid_id
          WHERE rp.route_id = $1
          ORDER BY rp.sequence_no NULLS LAST, p.pid_number
          LIMIT $2 OFFSET $3`,
        [routeId, limit, (page - 1) * limit],
      ),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  },

  async distinctPidWards(routeId, executor) {
    const { rows } = await executor.query(
      'SELECT DISTINCT p.ward_id FROM route_pids rp JOIN pids p ON p.id = rp.pid_id WHERE rp.route_id = $1', [routeId]);
    return rows.map((r) => r.ward_id);
  },
};
