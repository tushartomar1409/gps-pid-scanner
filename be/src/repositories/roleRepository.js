import { db as defaultDb } from '../config/database.js';

export const roleRepository = {
  async findByKey(roleKey, executor = defaultDb) {
    const { rows } = await executor.query(
      'SELECT id, role_key, role_name, permissions FROM roles WHERE role_key = $1',
      [roleKey],
    );
    return rows[0] || null;
  },

  async list(executor = defaultDb) {
    const { rows } = await executor.query('SELECT id, role_key, role_name, permissions FROM roles ORDER BY id');
    return rows;
  },
};
