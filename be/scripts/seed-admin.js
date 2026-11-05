// npm run seed:admin — idempotently creates the first SUPER_ADMIN from env:
//   SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD, SUPER_ADMIN_NAME (optional)
// If a user with that email already exists, nothing is changed (the password is never reset).
import { pool, closePool } from '../src/config/database.js';
import { hashPassword } from '../src/services/passwordService.js';

const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.SUPER_ADMIN_PASSWORD;
const name = process.env.SUPER_ADMIN_NAME?.trim() || 'Super Admin';

try {
  if (!email || !password) throw new Error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set');
  if (password.length < 12) throw new Error('SUPER_ADMIN_PASSWORD must be at least 12 characters');

  const existing = await pool.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
  if (existing.rows.length) {
    console.log(`Super admin already exists (id=${existing.rows[0].id}); no changes made.`);
  } else {
    const role = await pool.query("SELECT id FROM roles WHERE role_key = 'SUPER_ADMIN'");
    if (!role.rows.length) throw new Error('SUPER_ADMIN role missing — run `npm run migrate` first');
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING id`,
      [name, email, hash, role.rows[0].id],
    );
    console.log(rows.length ? `Super admin created (id=${rows[0].id}, email=${email}).` : 'Super admin already exists.');
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
