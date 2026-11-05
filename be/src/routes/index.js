import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware.js';
import { attachScope } from '../middleware/scopeMiddleware.js';
import { createAuthRoutes } from './authRoutes.js';
import {
  createZoneRoutes, createWardRoutes, createAgencyRoutes, createVehicleRoutes, createUserRoutes,
} from './masterRoutes.js';
import { createRoleRoutes, createLookupRoutes } from './referenceRoutes.js';
import { sendSuccess } from '../utils/responseHandler.js';

export function createApiRouter() {
  const api = Router();

  api.get('/health', (_req, res) => sendSuccess(res, { message: 'OK', data: { status: 'up' } }));
  api.use('/auth', createAuthRoutes());

  // Protected resources: valid token + row-level scope. Mounted per path (not as a catch-all)
  // so unknown /api/* paths still return 404 rather than 401.
  const guard = [authenticate, attachScope];
  api.use('/zones', ...guard, createZoneRoutes());
  api.use('/wards', ...guard, createWardRoutes());
  api.use('/agencies', ...guard, createAgencyRoutes());
  api.use('/vehicles', ...guard, createVehicleRoutes());
  api.use('/users', ...guard, createUserRoutes());
  api.use('/roles', ...guard, createRoleRoutes());
  api.use('/lookups', ...guard, createLookupRoutes());

  return api;
}
