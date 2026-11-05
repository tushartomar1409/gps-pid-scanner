// /api/gps/* and the flow.txt §17 vehicle aliases (GUIDE #6 D6, E).
import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { requirePermission, requireRole } from '../middleware/roleMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { idParam, queryId } from '../validators/common.js';
import { liveVehicles, liveVehicleDetail, vehicleHistory, latestLocation, providerStatus } from '../services/gps/gpsReadService.js';
import { getProvider, pollNow } from '../services/gps/gpsRuntime.js';
import { env } from '../config/env.js';
import { sendSuccess, sendError } from '../utils/responseHandler.js';

const isoWithOffset = z.iso.datetime({ offset: true, message: 'Use an ISO-8601 timestamp with offset, e.g. 2026-11-05T06:00:00+05:30' });
const CONNECTION = ['ONLINE', 'OFFLINE', 'NO_DATA', 'INACTIVE'];

const liveQuery = z.object({
  zone_id: queryId, ward_id: queryId, agency_id: queryId, vehicle_id: queryId, route_id: queryId,
  vehicle_type: z.string().trim().max(50).optional(),
  connection_status: z.enum(CONNECTION).optional(),
  view: z.enum(['full', 'map']).default('full'),
});
const historyWindow = {
  from: isoWithOffset,
  to: isoWithOffset,
  max_points: z.coerce.number().int().min(2).max(20_000).default(5000),
};
const historyQuery = z.object({ vehicle_id: z.coerce.number().int().positive(), ...historyWindow });

/** One poll-now per 30 s across the whole API (not per IP). */
const pollNowLimiter = () => rateLimit({
  windowMs: 30_000,
  limit: 1,
  keyGenerator: () => 'gps-poll-now',
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => sendError(res, { status: 429, message: 'poll-now is limited to once every 30 seconds' }),
});

export function createGpsRoutes() {
  const router = Router();
  const read = requirePermission('gps:read');

  router.get('/live-vehicles', read, validate({ query: liveQuery }), async (req, res) => {
    const data = await liveVehicles(req.valid.query, req.scope);
    sendSuccess(res, { message: 'Live vehicles fetched successfully', data });
  });
  router.get('/live-vehicles/:vehicleId', read, validate({ params: z.object({ vehicleId: z.coerce.number().int().positive() }) }), async (req, res) => {
    sendSuccess(res, { message: 'Vehicle details fetched successfully', data: await liveVehicleDetail(req.valid.params.vehicleId, req.scope) });
  });
  router.get('/vehicle-history', read, validate({ query: historyQuery }), async (req, res) => {
    sendSuccess(res, { message: 'Vehicle history fetched successfully', data: await vehicleHistory(req.valid.query, req.scope) });
  });
  router.get('/provider-status', read, async (_req, res) => {
    sendSuccess(res, { message: 'GPS provider status', data: await providerStatus(env.GPS_PROVIDER) });
  });
  router.post('/poll-now', requireRole('SUPER_ADMIN'), pollNowLimiter(), async (_req, res) => {
    getProvider(); // fail fast with a clear message for an unknown provider
    sendSuccess(res, { message: 'Poll run finished', data: await pollNow() });
  });
  return router;
}

/** flow.txt §17 aliases mounted under /api/vehicles (before the vehicle CRUD router). */
export function createVehicleGpsAliasRoutes() {
  const router = Router();
  const read = requirePermission('gps:read');
  router.get('/:id/latest-location', read, validate({ params: idParam }), async (req, res) => {
    sendSuccess(res, { message: 'Latest location fetched successfully', data: await latestLocation(req.valid.params.id, req.scope) });
  });
  router.get('/:id/history', read, validate({ params: idParam, query: z.object(historyWindow) }), async (req, res) => {
    const data = await vehicleHistory({ vehicle_id: req.valid.params.id, ...req.valid.query }, req.scope);
    sendSuccess(res, { message: 'Vehicle history fetched successfully', data });
  });
  return router;
}
