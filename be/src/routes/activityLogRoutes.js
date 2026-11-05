// GET /api/activity-logs (SUPER_ADMIN). details are passed through a recursive redactor at read time
// (defence in depth: writers already omit secrets, see userService.auditDetails).
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/roleMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { pagination, queryId } from '../validators/common.js';
import { db } from '../config/database.js';
import { SqlWhere, paginationMeta } from '../utils/sql.js';
import { sendSuccess } from '../utils/responseHandler.js';

const SECRET_KEY = /pass(word)?|secret|token|hash|api[_-]?key|authorization|credential/i;

/** Replaces values under secret-looking keys anywhere in a JSON value. */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v !== 'boolean' ? '[REDACTED]' : redactSecrets(v)]));
  }
  return value;
}

const query = z.object({
  ...pagination,
  user_id: queryId,
  module: z.string().trim().max(50).optional(),
  action: z.string().trim().max(50).optional(),
  reference_id: z.string().trim().max(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export function createActivityLogRoutes() {
  const router = Router();
  router.get('/', requireRole('SUPER_ADMIN'), validate({ query }), async (req, res) => {
    const q = req.valid.query;
    const w = new SqlWhere();
    w.eq('l.user_id', q.user_id);
    w.eq('l.module', q.module);
    w.eq('l.action', q.action);
    w.eq('l.reference_id', q.reference_id);
    if (q.from) w.add('l.created_at >= ?', q.from);
    if (q.to) w.add('l.created_at <= ?', q.to);
    const whereSql = w.toSql();
    const total = (await db.query(`SELECT count(*) AS total FROM activity_logs l ${whereSql}`, w.params)).rows[0].total;
    const lp = w.param(q.limit);
    const op = w.param((q.page - 1) * q.limit);
    const { rows } = await db.query(
      `SELECT l.id, l.user_id, u.name AS user_name, u.email AS user_email, l.action, l.module, l.reference_id, l.details,
              host(l.ip_address) AS ip_address, l.created_at
         FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id
        ${whereSql} ORDER BY l.created_at DESC, l.id DESC LIMIT ${lp} OFFSET ${op}`, w.params);
    sendSuccess(res, {
      message: 'Activity logs fetched successfully',
      data: rows.map((r) => ({ ...r, details: redactSecrets(r.details) })),
      pagination: paginationMeta(q.page, q.limit, total),
    });
  });
  return router;
}
