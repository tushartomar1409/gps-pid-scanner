// /api/pids — CRUD (shared router) + coordinates, map, import (GUIDE #4 A, B).
import { Router } from 'express';
import { createCrudRouter } from './crudRouter.js';
import { createCrudController, requestContext } from '../controllers/crudController.js';
import { requirePermission } from '../middleware/roleMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { idParam } from '../validators/common.js';
import { pidSchemas } from '../validators/pidValidators.js';
import { pidService } from '../services/pidService.js';
import { pidImportController, importUpload, importQuerySchema, templateQuerySchema } from '../controllers/pidImportController.js';
import { sendSuccess } from '../utils/responseHandler.js';

const pidController = createCrudController(pidService, { singular: 'PID', plural: 'PIDs' });

export function createPidRoutes() {
  const read = requirePermission('pids:read');
  const write = requirePermission('pids:write');
  const router = Router();

  // Static paths first so they are not captured by /:id.
  router.get('/map', read, validate({ query: pidSchemas.map }), async (req, res) => {
    const q = req.valid.query;
    const { points, truncated } = await pidService.map({ ...q, scope: req.scope });
    sendSuccess(res, { message: 'PID map points fetched successfully', data: { points, truncated, count: points.length } });
  });
  router.get('/import-template', write, validate({ query: templateQuerySchema }), pidImportController.template);
  router.post('/import', write, importUpload, validate({ query: importQuerySchema }), pidImportController.import);

  router.patch('/:id/coordinates', write, validate({ params: idParam, body: pidSchemas.coordinates }), async (req, res) => {
    const row = await pidService.updateCoordinates(req.valid.params.id, req.valid.body, requestContext(req));
    sendSuccess(res, { message: 'PID coordinates updated successfully', data: row });
  });

  router.use(createCrudRouter({ controller: pidController, schemas: pidSchemas, permission: 'pids' }));
  return router;
}
