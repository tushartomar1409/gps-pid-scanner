// /api/dashboard/* (dashboard:read, scoped) — flow.txt §13, §17.
import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/roleMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { queryId } from '../validators/common.js';
import { summary, grouped, dailyTrend, hourlyActivity, defaultDate } from '../services/dashboardService.js';
import { sendSuccess } from '../utils/responseHandler.js';

const isoDate = z.iso.date('Use YYYY-MM-DD');
const filters = { zone_id: queryId, ward_id: queryId, agency_id: queryId, vehicle_id: queryId };
const daily = z.object({ date: isoDate.optional(), ...filters }).transform((q) => ({ ...q, date: q.date ?? defaultDate() }));
const trend = z.object({ from: isoDate, to: isoDate, ...filters });

export function createDashboardRoutes() {
  const router = Router();
  router.use(requirePermission('dashboard:read'));
  router.get('/summary', validate({ query: daily }), async (req, res) => {
    sendSuccess(res, { message: 'Dashboard summary', data: await summary(req.valid.query, req.scope) });
  });
  for (const [path, group] of [['zone-coverage', 'zone'], ['ward-coverage', 'ward'], ['agency-performance', 'agency'], ['vehicle-performance', 'vehicle']]) {
    router.get(`/${path}`, validate({ query: daily }), async (req, res) => {
      sendSuccess(res, { message: `Dashboard ${path}`, data: await grouped(group, req.valid.query, req.scope) });
    });
  }
  router.get('/daily-trend', validate({ query: trend }), async (req, res) => {
    sendSuccess(res, { message: 'Daily coverage trend', data: await dailyTrend(req.valid.query, req.scope) });
  });
  router.get('/hourly-activity', validate({ query: daily }), async (req, res) => {
    sendSuccess(res, { message: 'Hourly GPS activity', data: await hourlyActivity(req.valid.query, req.scope) });
  });
  return router;
}
