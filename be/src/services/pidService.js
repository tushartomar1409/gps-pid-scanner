import { withTransaction } from '../config/database.js';
import { pidRepository } from '../repositories/pidRepository.js';
import { createMasterService } from './masterService.js';
import { resolveZoneWard } from './geoScopeService.js';
import { recordActivity } from './activityLogService.js';
import { getServiceAreaBbox } from './settingsService.js';
import { conflict, notFound } from '../utils/errors.js';
import { bboxWarning } from '../utils/geo.js';

export const normalisePidNumber = (v) => String(v).trim().toUpperCase();

const base = createMasterService({
  repo: pidRepository,
  module: 'pids',
  label: 'PID',
  prepare: async (d, existing, tx) => {
    if (d.pid_number !== undefined) d.pid_number = normalisePidNumber(d.pid_number);
    await resolveZoneWard(d, existing, tx);

    if (!existing) {
      // Create: coordinates optional; coord_status follows presence.
      d.coord_status = d.latitude != null ? 'IMPORTED' : 'MISSING';
    } else if (d.ward_id !== undefined && Number(d.ward_id) !== Number(existing.ward_id)) {
      // Moving a PID to another ward would break the "route PIDs are in the route's ward" rule.
      const routes = await pidRepository.routeWardsForPid(existing.id, tx);
      const clashing = routes.filter((r) => Number(r.ward_id) !== Number(d.ward_id));
      if (clashing.length) {
        throw conflict('PID is assigned to routes in its current ward; remove it from those routes first', [
          { field: 'ward_id', message: `Routes: ${clashing.map((r) => r.route_code).join(', ')}` },
        ]);
      }
    }
    return d;
  },
});

async function withBboxWarning(row) {
  if (row?.latitude == null) return row;
  const w = bboxWarning(row.latitude, row.longitude, await getServiceAreaBbox());
  return w ? { ...row, warning: w.message } : row;
}

export const pidService = {
  ...base,

  async create(data, ctx) {
    return withBboxWarning(await base.create(data, ctx));
  },

  /**
   * Manual coordinate correction. Never touches route_assignment_pids snapshots (history is frozen).
   */
  async updateCoordinates(id, { latitude, longitude, verified = false }, ctx) {
    const row = await withTransaction(async (tx) => {
      const existing = await pidRepository.findById(id, ctx.scope, tx);
      if (!existing) throw notFound('PID not found');
      const coord_status = verified ? 'VERIFIED' : 'MANUALLY_CORRECTED';
      await pidRepository.update(id, { latitude, longitude, coord_status }, tx);
      await recordActivity(ctx, {
        action: 'UPDATE_COORDINATES',
        module: 'pids',
        referenceId: id,
        details: {
          pid_number: existing.pid_number,
          old: { latitude: existing.latitude, longitude: existing.longitude, coord_status: existing.coord_status },
          new: { latitude, longitude, coord_status },
        },
      }, tx);
      return pidRepository.findById(id, null, tx);
    });
    return withBboxWarning(row);
  },

  map: (opts) => pidRepository.mapPoints(opts),
};
