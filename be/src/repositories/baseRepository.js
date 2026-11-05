// Generic parameterized CRUD repository for master tables. Column names are fixed by the
// definition (never taken from user input); values are always bound parameters.
import { db as defaultDb } from '../config/database.js';
import { SqlWhere } from '../utils/sql.js';
import { applyScope } from '../middleware/scopeMiddleware.js';

/**
 * @param {object} def
 * @param {string} def.table          physical table name
 * @param {string} def.alias          alias used in select/from SQL
 * @param {string} def.select         SELECT list (no "SELECT")
 * @param {string} def.from           FROM clause incl. joins (no "FROM")
 * @param {string[]} def.writable     columns allowed in INSERT/UPDATE
 * @param {string[]} [def.search]     columns for ?search=
 * @param {Record<string,string>} [def.filters]  query key -> column (equality)
 * @param {object} [def.scope]        { zone, ward, agency } scope columns
 * @param {string} [def.orderBy]
 */
export function createCrudRepository(def) {
  const { table, alias, select, from, writable, search = [], filters = {}, scope: scopeCols = {} } = def;
  const orderBy = def.orderBy || `${alias}.id ASC`;

  function baseWhere(scope) {
    return applyScope(new SqlWhere(), scope, scopeCols);
  }

  return {
    async list({ page = 1, limit = 20, search: term, filters: f = {}, scope } = {}, executor = defaultDb) {
      const where = baseWhere(scope);
      for (const [key, column] of Object.entries(filters)) where.eq(column, f[key]);
      where.search(search, term);
      const whereSql = where.toSql();

      const countRes = await executor.query(`SELECT count(*) AS total FROM ${from} ${whereSql}`, where.params);
      const limitP = where.param(limit);
      const offsetP = where.param((page - 1) * limit);
      const rowsRes = await executor.query(
        `SELECT ${select} FROM ${from} ${whereSql} ORDER BY ${orderBy} LIMIT ${limitP} OFFSET ${offsetP}`,
        where.params,
      );
      return { rows: rowsRes.rows, total: countRes.rows[0].total };
    },

    async findById(id, scope, executor = defaultDb) {
      const where = baseWhere(scope).add(`${alias}.id = ?`, id);
      const { rows } = await executor.query(`SELECT ${select} FROM ${from} ${where.toSql()}`, where.params);
      return rows[0] || null;
    },

    async insert(data, executor = defaultDb) {
      const cols = writable.filter((c) => data[c] !== undefined);
      const values = cols.map((c) => data[c]);
      const placeholders = cols.map((_, i) => `$${i + 1}`);
      const { rows } = await executor.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
        values,
      );
      return rows[0].id;
    },

    /** Returns the id when a row was updated, null when not found. */
    async update(id, data, executor = defaultDb) {
      const cols = writable.filter((c) => data[c] !== undefined);
      if (!cols.length) {
        const { rows } = await executor.query(`SELECT id FROM ${table} WHERE id = $1`, [id]);
        return rows[0]?.id ?? null;
      }
      const sets = cols.map((c, i) => `${c} = $${i + 1}`);
      const { rows } = await executor.query(
        `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${cols.length + 1} RETURNING id`,
        [...cols.map((c) => data[c]), id],
      );
      return rows[0]?.id ?? null;
    },
  };
}
