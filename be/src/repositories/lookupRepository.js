// Lightweight, unpaginated lists of ACTIVE reference records for form dropdowns.
// Same row-level scope columns as the full master repositories.
import { db as defaultDb } from '../config/database.js';
import { SqlWhere } from '../utils/sql.js';
import { applyScope } from '../middleware/scopeMiddleware.js';

const LOOKUPS = {
  zones: {
    sql: 'SELECT z.id, z.zone_name AS name, z.zone_code AS code, z.id AS zone_id FROM zones z',
    status: 'z.status',
    scope: { zone: 'z.id' },
    orderBy: 'z.zone_name, z.id',
  },
  wards: {
    sql: 'SELECT w.id, w.ward_name AS name, w.ward_number AS code, w.zone_id FROM wards w',
    status: 'w.status',
    scope: { zone: 'w.zone_id', ward: 'w.id' },
    orderBy: 'w.zone_id, w.ward_number, w.id',
  },
  agencies: {
    sql: 'SELECT a.id, a.agency_name AS name, NULL::text AS code, NULL::int AS zone_id FROM agencies a',
    status: 'a.status',
    scope: { agency: 'a.id' },
    orderBy: 'a.agency_name, a.id',
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
