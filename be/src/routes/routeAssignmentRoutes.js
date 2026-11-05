// /api/route-assignments (GUIDE #4 D).
import { Router } from 'express';
import { requirePermission } from '../middleware/roleMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { idParam } from '../validators/common.js';
import { routeAssignmentSchemas as s } from '../validators/routeAssignmentValidators.js';
import { routeAssignmentService as svc } from '../services/routeAssignmentService.js';
import { requestContext } from '../controllers/crudController.js';
import { sendSuccess } from '../utils/responseHandler.js';
import { compareAssignment } from '../services/routeComparisonService.js';

export function createRouteAssignmentRoutes() {
  const read = requirePermission('assignments:read');
  const write = requirePermission('assignments:write');
  const router = Router();

  router.get('/', read, validate({ query: s.list }), async (req, res) => {
    const { rows, pagination } = await svc.list(req.valid.query, req.scope);
    sendSuccess(res, { message: 'Route assignments fetched successfully', data: rows, pagination });
  });
  router.post('/', write, validate({ body: s.create }), async (req, res) => {
    const data = await svc.create(req.valid.body, requestContext(req));
    sendSuccess(res, { status: 201, message: 'Route assignment created successfully', data });
  });
  router.post('/bulk', write, validate({ body: s.bulk }), async (req, res) => {
    const data = await svc.bulk(req.valid.body, requestContext(req));
    sendSuccess(res, { message: 'Bulk assignment processed', data });
  });
  router.get('/:id', read, validate({ params: idParam, query: s.get }), async (req, res) => {
    const data = await svc.get(req.valid.params.id, req.valid.query, req.scope);
    sendSuccess(res, { message: 'Route assignment fetched successfully', data });
  });
  router.get('/:id/map-pids', read, validate({ params: idParam }), async (req, res) => {
    sendSuccess(res, { message: 'Assignment PIDs for map', data: await svc.mapPids(req.valid.params.id, req.scope) });
  });
  router.get('/:id/comparison', read, validate({ params: idParam }), async (req, res) => {
    sendSuccess(res, { message: 'Route comparison', data: await compareAssignment(req.valid.params.id, req.scope) });
  });
  router.patch('/:id/cancel', write, validate({ params: idParam }), async (req, res) => {
    const data = await svc.cancel(req.valid.params.id, requestContext(req));
    sendSuccess(res, { message: 'Route assignment cancelled', data });
  });
  router.post('/:id/resnapshot', write, validate({ params: idParam }), async (req, res) => {
    const data = await svc.resnapshot(req.valid.params.id, requestContext(req));
    sendSuccess(res, { message: 'Route assignment PID snapshot rebuilt', data });
  });
  return router;
}
