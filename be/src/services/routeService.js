// Routes master (GUIDE #4 C). Editing a route NEVER touches route_assignment_pids snapshots.
import { withTransaction } from '../config/database.js';
import { routeRepository } from '../repositories/routeRepository.js';
import { createMasterService } from './masterService.js';
import { resolveZoneWard } from './geoScopeService.js';
import { recordActivity } from './activityLogService.js';
import { conflict, notFound, unprocessable } from '../utils/errors.js';
import { paginationMeta } from '../utils/sql.js';

const base = createMasterService({
  repo: routeRepository,
  module: 'routes',
  label: 'Route',
  prepare: async (d, existing, tx) => {
    if (d.route_code !== undefined) d.route_code = d.route_code.toUpperCase();
    await resolveZoneWard(d, existing, tx);
    if (existing && d.ward_id !== undefined && Number(d.ward_id) !== Number(existing.ward_id)) {
      const wards = await routeRepository.distinctPidWards(existing.id, tx);
      if (wards.some((w) => Number(w) !== Number(d.ward_id))) {
        throw conflict('Route has PIDs in its current ward; remove them before moving the route to another ward');
      }
    }
    return d;
  },
});

async function getVisibleRoute(id, scope, tx) {
  const route = await routeRepository.findById(id, scope, tx);
  if (!route) throw notFound('Route not found');
  return route;
}

export const routeService = {
  ...base,

  async listPids(id, { page, limit }, scope) {
    await getVisibleRoute(id, scope);
    const { rows, total } = await routeRepository.listPids(id, { page, limit });
    return { rows, pagination: paginationMeta(page, limit, total) };
  },

  /**
   * mode add     — append PIDs (existing members untouched)
   * mode replace — route PID list becomes exactly pid_ids, in the given order
   * mode remove  — drop the listed PIDs
   * PIDs added must exist, be ACTIVE and be in the route's ward (422 with offending ids otherwise).
   */
  async assignPids(id, { pid_ids: rawIds, mode }, ctx) {
    const pidIds = [...new Set(rawIds)];
    return withTransaction(async (tx) => {
      await getVisibleRoute(id, ctx.scope, tx);
      const route = await routeRepository.lockById(id, tx); // serialise concurrent edits of this route

      if (mode !== 'remove') {
        const { rows } = await tx.query('SELECT id, status, ward_id FROM pids WHERE id = ANY($1::bigint[])', [pidIds]);
        const found = new Map(rows.map((r) => [Number(r.id), r]));
        const missing = pidIds.filter((p) => !found.has(p));
        const inactive = rows.filter((r) => r.status !== 'ACTIVE').map((r) => Number(r.id));
        const wrongWard = rows.filter((r) => r.status === 'ACTIVE' && Number(r.ward_id) !== Number(route.ward_id)).map((r) => Number(r.id));
        const errors = [];
        if (missing.length) errors.push({ field: 'pid_ids', message: 'PIDs not found', ids: missing });
        if (inactive.length) errors.push({ field: 'pid_ids', message: 'PIDs are inactive', ids: inactive });
        if (wrongWard.length) errors.push({ field: 'pid_ids', message: "PIDs are not in the route's ward", ids: wrongWard });
        if (errors.length) throw unprocessable('Some PIDs cannot be assigned to this route', errors);
      }

      let added = 0;
      let removed = 0;
      if (mode === 'remove') {
        removed = (await tx.query('DELETE FROM route_pids WHERE route_id = $1 AND pid_id = ANY($2::bigint[])', [id, pidIds])).rowCount;
      } else if (mode === 'replace') {
        removed = (await tx.query('DELETE FROM route_pids WHERE route_id = $1 AND pid_id <> ALL($2::bigint[])', [id, pidIds])).rowCount;
        const res = await tx.query(
          `INSERT INTO route_pids (route_id, pid_id, sequence_no)
           SELECT $1, t.pid_id, t.ord FROM unnest($2::bigint[]) WITH ORDINALITY AS t(pid_id, ord)
           ON CONFLICT (route_id, pid_id) DO UPDATE SET sequence_no = EXCLUDED.sequence_no
           RETURNING (xmax = 0) AS inserted`,
          [id, pidIds],
        );
        added = res.rows.filter((r) => r.inserted).length;
      } else {
        const res = await tx.query(
          `INSERT INTO route_pids (route_id, pid_id, sequence_no)
           SELECT $1, t.pid_id, (SELECT COALESCE(max(sequence_no), 0) FROM route_pids WHERE route_id = $1) + t.ord
             FROM unnest($2::bigint[]) WITH ORDINALITY AS t(pid_id, ord)
           ON CONFLICT (route_id, pid_id) DO NOTHING`,
          [id, pidIds],
        );
        added = res.rowCount;
      }

      const total = (await tx.query('SELECT count(*) AS n FROM route_pids WHERE route_id = $1', [id])).rows[0].n;
      await recordActivity(ctx, {
        action: 'ASSIGN_PIDS', module: 'routes', referenceId: id,
        details: { mode, requested: pidIds.length, added, removed, total },
      }, tx);
      return { route_id: id, mode, added, removed, total };
    });
  },
};
