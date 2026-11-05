// password_hash is only ever selected by findForLogin(); every other query omits it.
import { db as defaultDb } from '../config/database.js';
import { createCrudRepository } from './baseRepository.js';

const crud = createCrudRepository({
  table: 'users',
  alias: 'u',
  select: `u.id, u.name, u.email, u.role_id, r.role_key, r.role_name, u.zone_id, z.zone_name,
           u.ward_id, w.ward_name, u.agency_id, a.agency_name, u.status, u.last_login_at,
           u.created_at, u.updated_at`,
  from: `users u
         JOIN roles r         ON r.id = u.role_id
         LEFT JOIN zones z    ON z.id = u.zone_id
         LEFT JOIN wards w    ON w.id = u.ward_id
         LEFT JOIN agencies a ON a.id = u.agency_id`,
  writable: ['name', 'email', 'password_hash', 'role_id', 'zone_id', 'ward_id', 'agency_id', 'status'],
  search: ['u.name', 'u.email'],
  filters: { status: 'u.status', role_key: 'r.role_key', zone_id: 'u.zone_id', agency_id: 'u.agency_id' },
  orderBy: 'u.name ASC, u.id ASC',
});

export const userRepository = {
  ...crud,

  async findForLogin(email, executor = defaultDb) {
    const { rows } = await executor.query(
      `SELECT u.id, u.email, u.password_hash, u.status, u.locked_until, (u.locked_until > now()) AS is_locked
         FROM users u WHERE lower(u.email) = lower($1)`,
      [email],
    );
    return rows[0] || null;
  },

  async findAuthById(id, executor = defaultDb) {
    const { rows } = await executor.query(
      `SELECT u.id, u.name, u.email, u.status, u.zone_id, u.ward_id, u.agency_id, u.token_version,
              r.role_key, r.permissions
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1`,
      [id],
    );
    return rows[0] || null;
  },

  async touchLastLogin(id, executor = defaultDb) {
    await executor.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
  },
};
