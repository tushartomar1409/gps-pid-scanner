// Generic master-data service: scoped reads, transactional writes + activity log, soft deactivate.
import { withTransaction } from '../config/database.js';
import { notFound } from '../utils/errors.js';
import { paginationMeta } from '../utils/sql.js';
import { recordActivity, ACTIONS } from './activityLogService.js';

/**
 * @param {object} opts
 * @param {object} opts.repo        createCrudRepository() instance
 * @param {string} opts.module      activity_logs.module value
 * @param {string} opts.label       human label for messages ("Vehicle")
 * @param {(data, existing, tx) => Promise<object>|object} [opts.prepare]
 *        normalise + business-validate the merged record before insert/update; returns data to write.
 */
export function createMasterService({ repo, module, label, prepare = (d) => d }) {
  async function getOrThrow(id, scope, executor) {
    const row = await repo.findById(id, scope, executor);
    if (!row) throw notFound(`${label} not found`);
    return row;
  }

  return {
    async list(query, scope) {
      const { page, limit, search, ...filters } = query;
      const { rows, total } = await repo.list({ page, limit, search, filters, scope });
      return { rows, pagination: paginationMeta(page, limit, total) };
    },

    get: (id, scope) => getOrThrow(id, scope),

    async create(data, ctx) {
      return withTransaction(async (tx) => {
        const toWrite = await prepare({ ...data }, null, tx);
        const id = await repo.insert(toWrite, tx);
        await recordActivity(ctx, { action: ACTIONS.CREATE, module, referenceId: id, details: toWrite }, tx);
        return repo.findById(id, null, tx);
      });
    },

    async update(id, data, ctx) {
      return withTransaction(async (tx) => {
        const existing = await getOrThrow(id, ctx.scope, tx);
        const toWrite = await prepare({ ...data }, existing, tx);
        await repo.update(id, toWrite, tx);
        await recordActivity(ctx, { action: ACTIONS.UPDATE, module, referenceId: id, details: toWrite }, tx);
        return repo.findById(id, null, tx);
      });
    },

    async deactivate(id, ctx) {
      return withTransaction(async (tx) => {
        await getOrThrow(id, ctx.scope, tx);
        await repo.update(id, { status: 'INACTIVE' }, tx);
        await recordActivity(ctx, { action: ACTIONS.DEACTIVATE, module, referenceId: id }, tx);
        return repo.findById(id, null, tx);
      });
    },
  };
}
