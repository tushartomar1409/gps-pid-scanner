// Builds the standard master-resource router:
//   GET    /                 list   (<perm>:read)
//   GET    /:id              get    (<perm>:read)
//   POST   /                 create (<perm>:write)
//   PUT    /:id              update (<perm>:write, partial body)
//   PATCH  /:id/deactivate   soft-deactivate (<perm>:write) — no hard deletes
import { Router } from 'express';
import { requirePermission } from '../middleware/roleMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { idParam } from '../validators/common.js';

export function createCrudRouter({ controller, schemas, permission, guards = [] }) {
  const read = requirePermission(`${permission}:read`);
  const write = requirePermission(`${permission}:write`);
  const router = Router();
  if (guards.length) router.use(...guards);
  router.get('/', read, validate({ query: schemas.list }), controller.list);
  router.get('/:id', read, validate({ params: idParam }), controller.get);
  router.post('/', write, validate({ body: schemas.create }), controller.create);
  router.put('/:id', write, validate({ params: idParam, body: schemas.update }), controller.update);
  router.patch('/:id/deactivate', write, validate({ params: idParam }), controller.deactivate);
  return router;
}
