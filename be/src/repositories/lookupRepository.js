// Lightweight, unpaginated lists of ACTIVE reference records for form dropdowns.
// Same row-level scope columns as the full master repositories.
import { db as defaultDb } from '../config/database.js';
import { SqlWhere } from '../utils/sql.js';
import { applyScope } from '../middleware/scopeMiddleware.js';

// Every lookup returns the same shape: { id, name, code, zone_id, ward_id, agency_id } (nulls where n/a).
const LOOKUPS = {
  zones: {
    sql: 'SELECT z.id, z.zone_name AS name, z.zone_code AS code, z.id AS zone_id, NULL::int AS ward_id, NULL::int AS agency_id FROM zones z',
    status: 'z.status',
    scope: { zone: 'z.id' },
    orderBy: 'z.zone_name, z.id',
  },
  wards: {
    sql: 'SELECT w.id, w.ward_name AS name, w.ward_number AS code, w.zone_id, w.id AS ward_id, NULL::int AS agency_id FROM wards w',
    status: 'w.status',
    scope: { zone: 'w.zone_id', ward: 'w.id' },
    orderBy: 'w.zone_id, w.ward_number, w.id',
  },
  agencies: {
    sql: 'SELECT a.id, a.agency_name AS name, NULL::text AS code, NULL::int AS zone_id, NULL::int AS ward_id, a.id AS agency_id FROM agencies a',
    status: 'a.status',
    scope: { agency: 'a.id' },
    orderBy: 'a.agency_name, a.id',
  },
  // Phase 2b: route builder + assignment forms need full (unpaginated) dropdowns.
  routes: {
    sql: 'SELECT r.id, r.route_name AS name, r.route_code AS code, r.zone_id, r.ward_id, r.agency_id FROM routes r',
    status: 'r.status',
    scope: { zone: 'r.zone_id', ward: 'r.ward_id', agency: 'r.agency_id' },
    orderBy: 'r.route_code, r.id',
  },
  vehicles: {
    sql: 'SELECT v.id, v.vehicle_number AS name, v.vehicle_type AS code, v.zone_id, v.ward_id, v.agency_id FROM vehicles v',
    status: 'v.status',
    scope: { zone: 'v.zone_id', ward: 'v.ward_id', agency: 'v.agency_id' },
    orderBy: 'v.vehicle_number, v.id',
  },
};

export const LOOKUP_TYPES = Object.keys(LOOKUPS);

export const lookupRepository = {
  async list(type, scope, executor = defaultDb) {
    const def = LOOKUPS[type];
    const where = applyScope(new SqlWhere(), scope, def.scope).add(`${def.status} = ?`, 'ACTIVE');
    const { rows } = await executor.query(`${def.sql} ${where.toSql()} ORDER BY ${def.orderBy}`, where.params);
    return rows;
  },
};
