// Reference data for form dropdowns:
//   GET /api/roles                               (users:read)
//   GET /api/lookups?types=zones,wards,agencies  (<type>:read for every requested type; scope applied)
import { Router } from 'express';
import { z } from 'zod';
import { requirePermission, hasPermission } from '../middleware/roleMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { roleRepository } from '../repositories/roleRepository.js';
import { lookupRepository, LOOKUP_TYPES } from '../repositories/lookupRepository.js';
import { sendSuccess } from '../utils/responseHandler.js';
import { forbidden } from '../utils/errors.js';

const lookupQuery = z.object({
  types: z
    .string()
    .trim()
    .min(1)
    .transform((s) => [...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))])
    .pipe(z.array(z.enum(LOOKUP_TYPES)).min(1)),
});

export function createRoleRoutes() {
  const router = Router();
  router.get('/', requirePermission('users:read'), async (_req, res) => {
    const roles = await roleRepository.list();
    sendSuccess(res, {
      message: 'Roles fetched successfully',
      data: roles.map(({ role_key, role_name }) => ({ role_key, role_name })),
    });
  });
  return router;
}

export function createLookupRoutes() {
  const router = Router();
  router.get('/', validate({ query: lookupQuery }), async (req, res) => {
    const { types } = req.valid.query;
    const denied = types.filter((t) => !hasPermission(req.user, `${t}:read`));
    if (denied.length) throw forbidden(`Missing permission for lookups: ${denied.join(', ')}`);
    const entries = await Promise.all(types.map(async (t) => [t, await lookupRepository.list(t, req.scope)]));
    sendSuccess(res, { message: 'Lookups fetched successfully', data: Object.fromEntries(entries) });
  });
  return router;
}
