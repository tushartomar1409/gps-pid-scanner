// /api/routes — CRUD + PID membership (GUIDE #4 C).
import { Router } from 'express';
import { createCrudRouter } from './crudRouter.js';
import { createCrudController, requestContext } from '../controllers/crudController.js';
import { requirePermission } from '../middleware/roleMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { idParam } from '../validators/common.js';
import { routeSchemas } from '../validators/routeValidators.js';
import { routeService } from '../services/routeService.js';
import { sendSuccess } from '../utils/responseHandler.js';

const routeController = createCrudController(routeService, { singular: 'Route', plural: 'Routes' });

export function createRouteRoutes() {
  const router = Router();
  router.get('/:id/pids', requirePermission('routes:read'), validate({ params: idParam, query: routeSchemas.pidsQuery }), async (req, res) => {
    const { rows, pagination } = await routeService.listPids(req.valid.params.id, req.valid.query, req.scope);
    sendSuccess(res, { message: 'Route PIDs fetched successfully', data: rows, pagination });
  });
  router.post('/:id/assign-pids', requirePermission('routes:write'), validate({ params: idParam, body: routeSchemas.assignPids }), async (req, res) => {
    const data = await routeService.assignPids(req.valid.params.id, req.valid.body, requestContext(req));
    sendSuccess(res, { message: 'Route PIDs updated successfully', data });
  });
  router.use(createCrudRouter({ controller: routeController, schemas: routeSchemas, permission: 'routes' }));
  return router;
}
