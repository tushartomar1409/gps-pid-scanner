import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware.js';
import { attachScope } from '../middleware/scopeMiddleware.js';
import { createAuthRoutes } from './authRoutes.js';
import {
  createZoneRoutes, createWardRoutes, createAgencyRoutes, createVehicleRoutes, createUserRoutes,
} from './masterRoutes.js';
import { createRoleRoutes, createLookupRoutes } from './referenceRoutes.js';
import { createPidRoutes } from './pidRoutes.js';
import { createRouteRoutes } from './routeRoutes.js';
import { createRouteAssignmentRoutes } from './routeAssignmentRoutes.js';
import { createSettingsRoutes } from './settingsRoutes.js';
import { createGpsRoutes, createVehicleGpsAliasRoutes } from './gpsRoutes.js';
import { createPidVisitRoutes, createDetectionRoutes, createSettingsAdminRoutes } from './detectionRoutes.js';
import { createDashboardRoutes } from './dashboardRoutes.js';
import { createActivityLogRoutes } from './activityLogRoutes.js';
import { createReportRoutes } from './reportRoutes.js';
import { readiness, details as opsDetails } from '../services/opsService.js';
import { requireRole } from '../middleware/roleMiddleware.js';
import { sendSuccess } from '../utils/responseHandler.js';

export function createApiRouter() {
  const api = Router();

  api.get('/health', (_req, res) => sendSuccess(res, { message: 'OK', data: { status: 'up' } })); // liveness
  // Readiness (GUIDE #11 E): DB reachable + migrations up to date, else 503. Unauthenticated, no details.
  api.get('/health/ready', async (_req, res) => {
    const r = await readiness();
    if (r.ready) return sendSuccess(res, { message: 'Ready', data: r });
    return res.status(503).json({ success: false, message: 'Not ready', data: r });
  });
  api.use('/auth', createAuthRoutes());

  // Protected resources: valid token + row-level scope. Mounted per path (not as a catch-all)
  // so unknown /api/* paths still return 404 rather than 401.
  const guard = [authenticate, attachScope];
  api.use('/zones', ...guard, createZoneRoutes());
  api.use('/wards', ...guard, createWardRoutes());
  api.use('/agencies', ...guard, createAgencyRoutes());
  api.use('/vehicles', ...guard, createVehicleGpsAliasRoutes(), createVehicleRoutes());
  api.use('/users', ...guard, createUserRoutes());
  api.use('/roles', ...guard, createRoleRoutes());
  api.use('/lookups', ...guard, createLookupRoutes());
  api.use('/pids', ...guard, createPidRoutes());
  api.use('/routes', ...guard, createRouteRoutes());
  api.use('/route-assignments', ...guard, createRouteAssignmentRoutes());
  // /settings/public (any user) is matched first; everything else under /settings is SUPER_ADMIN.
  api.use('/settings', ...guard, createSettingsRoutes(), createSettingsAdminRoutes());
  api.use('/gps', ...guard, createGpsRoutes());
  api.use('/pid-visits', ...guard, createPidVisitRoutes());
  api.use('/detection', ...guard, createDetectionRoutes());
  api.use('/dashboard', ...guard, createDashboardRoutes());
  api.use('/activity-logs', ...guard, createActivityLogRoutes());
  api.use('/reports', ...guard, createReportRoutes());
  api.get('/health/details', ...guard, requireRole('SUPER_ADMIN'), async (_req, res) => {
    sendSuccess(res, { message: 'Operational details', data: await opsDetails() });
  });

  return api;
}
