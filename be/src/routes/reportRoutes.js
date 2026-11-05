// /api/reports/* (GUIDE #10 A, C; flow §14, §17). reports:read to preview, reports:export to download.
import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { requirePermission, requireRole } from '../middleware/roleMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { pagination, queryId } from '../validators/common.js';
import { env } from '../config/env.js';
import { REPORTS } from '../services/reports/definitions.js';
import { exportToResponse, preview } from '../services/reports/reportService.js';
import { ARCHIVE_TYPES, archiveFile, listArchive } from '../services/reports/archiveService.js';
import { CONTENT_TYPES } from '../services/reports/writers.js';
import { sendSuccess, sendError } from '../utils/responseHandler.js';
import { badRequest } from '../utils/errors.js';

const isoDate = z.iso.date('Use YYYY-MM-DD');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const FORMATS = ['xlsx', 'pdf', 'csv'];
const STATUS_ALL = ['GPS_VISIT_CONFIRMED', 'GPS_VISIT_CANDIDATE', 'NOT_VISITED', 'GPS_DATA_UNAVAILABLE'];

const reportQuery = z.object({
  ...pagination,
  date: isoDate.optional(), from: isoDate.optional(), to: isoDate.optional(),
  zone_id: queryId, ward_id: queryId, agency_id: queryId, vehicle_id: queryId, route_id: queryId,
  status: z.enum(STATUS_ALL).optional(),
  sort: z.string().trim().max(40).optional(), dir: z.enum(['asc', 'desc']).optional(),
  format: z.enum(FORMATS).optional(),
});
const trackQuery = z.object({
  vehicle_id: z.coerce.number().int().positive(), date: isoDate.optional(), start: hhmm.optional(), end: hhmm.optional(),
  format: z.enum(['csv', 'xlsx']).default('csv'),
});
const archiveQuery = z.object({ ...pagination, from: isoDate.optional(), to: isoDate.optional(), type: z.enum(ARCHIVE_TYPES).optional() });

/** 5 exports / minute / user (GUIDE #10 B7). */
export const exportLimiter = (limit = env.REPORTS_EXPORTS_PER_MIN) => rateLimit({
  windowMs: 60_000,
  limit,
  keyGenerator: (req) => (req.user?.id ? `export:user:${req.user.id}` : `export:ip:${ipKeyGenerator(req.ip)}`),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => sendError(res, { status: 429, message: `Export limit reached (${limit} per minute). Please wait a moment and try again.` }),
});

export function createReportRoutes({ limiter = exportLimiter() } = {}) {
  const router = Router();
  const read = requirePermission('reports:read');
  const exp = requirePermission('reports:export');

  // Archive first so "/archive" never matches "/:report".
  const archiveRole = requireRole('SUPER_ADMIN', 'DEPARTMENT_ADMIN');
  router.get('/archive', archiveRole, validate({ query: archiveQuery }), async (req, res) => {
    const { rows, pagination: p } = await listArchive(req.valid.query);
    sendSuccess(res, { message: 'Report archive', data: rows, pagination: p });
  });
  router.get('/archive/:id/download', archiveRole, validate({ params: z.object({ id: z.coerce.number().int().positive() }) }), async (req, res) => {
    const f = await archiveFile(req.valid.params.id);
    res.setHeader('Content-Type', CONTENT_TYPES[f.format]);
    res.setHeader('Content-Length', f.size);
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const s = fs.createReadStream(f.abs);
    s.on('error', (err) => res.destroy(err));
    s.pipe(res);
  });

  // flow §14.6: track export (CSV/XLSX only, full resolution, ≤ 50k points).
  router.get('/vehicle-tracking', read, exp, limiter, validate({ query: trackQuery }), async (req, res) => {
    await exportToResponse('vehicle-tracking', req.valid.query, req.valid.query.format, req, res);
  });

  // flow §17 alias: /export-excel?report=<name>&...
  router.get('/export-excel', read, exp, limiter, validate({ query: reportQuery.extend({ report: z.enum(Object.keys(REPORTS).filter((k) => k !== 'vehicle-tracking')) }) }), async (req, res) => {
    const { report, ...q } = req.valid.query;
    await exportToResponse(report, q, 'xlsx', req, res);
  });

  for (const name of Object.keys(REPORTS).filter((k) => k !== 'vehicle-tracking')) {
    const statusOk = REPORTS[name].statusFilter;
    router.get(`/${name}`, read, validate({ query: reportQuery }), (req, res, next) => {
      const q = req.valid.query;
      if (q.status && !statusOk?.includes(q.status)) {
        return next(badRequest(`status must be one of: ${(statusOk || []).join(', ') || '(none for this report)'}`));
      }
      if (!q.format) return next();
      // Export path: permission + rate limit, then stream.
      return exp(req, res, (e1) => (e1 ? next(e1) : limiter(req, res, (e2) => (e2 ? next(e2) : exportToResponse(name, q, q.format, req, res).catch(next)))));
    }, async (req, res) => {
      sendSuccess(res, { message: `${REPORTS[name].title} preview`, data: await preview(name, req.valid.query, req.scope) });
    });
  }
  return router;
}

