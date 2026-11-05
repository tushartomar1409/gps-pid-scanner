// Generic controller for master resources. Express 5 forwards rejected promises to errorHandler.
import { sendSuccess } from '../utils/responseHandler.js';

export const requestContext = (req) => ({ user: req.user, ip: req.ip, scope: req.scope });

export function createCrudController(service, { singular, plural }) {
  return {
    async list(req, res) {
      const { rows, pagination } = await service.list(req.valid.query, req.scope);
      sendSuccess(res, { message: `${plural} fetched successfully`, data: rows, pagination });
    },
    async get(req, res) {
      const row = await service.get(req.valid.params.id, req.scope);
      sendSuccess(res, { message: `${singular} fetched successfully`, data: row });
    },
    async create(req, res) {
      const row = await service.create(req.valid.body, requestContext(req));
      sendSuccess(res, { status: 201, message: `${singular} created successfully`, data: row });
    },
    async update(req, res) {
      const row = await service.update(req.valid.params.id, req.valid.body, requestContext(req));
      sendSuccess(res, { message: `${singular} updated successfully`, data: row });
    },
    async deactivate(req, res) {
      const row = await service.deactivate(req.valid.params.id, requestContext(req));
      sendSuccess(res, { message: `${singular} deactivated successfully`, data: row });
    },
  };
}
