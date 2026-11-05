import { db as defaultDb } from '../config/database.js';

export const activityLogRepository = {
  async insert({ userId = null, action, module, referenceId = null, details = null, ip = null }, executor = defaultDb) {
    await executor.query(
      `INSERT INTO activity_logs (user_id, action, module, reference_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, action, module, referenceId === null ? null : String(referenceId), details, normaliseIp(ip)],
    );
  },
};

// Express may report IPv4-mapped IPv6 ("::ffff:1.2.3.4"); INET accepts both, but reject garbage.
export function normaliseIp(ip) {
  if (!ip) return null;
  const v = String(ip).replace(/^::ffff:/, '');
  return /^[0-9a-fA-F:.]+$/.test(v) ? v : null;
}
