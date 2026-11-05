// User administration (SUPER_ADMIN only — enforced at the route). Never returns password_hash.
import { withTransaction } from '../config/database.js';
import { userRepository } from '../repositories/userRepository.js';
import { roleRepository } from '../repositories/roleRepository.js';
import { hashPassword } from './passwordService.js';
import { resolveZoneWard } from './geoScopeService.js';
import { recordActivity, ACTIONS } from './activityLogService.js';
import { notFound, unprocessable } from '../utils/errors.js';
import { paginationMeta } from '../utils/sql.js';

const MODULE = 'users';

/**
 * Role scope rules (GUIDE #2 task 8). Fields irrelevant to the role are cleared so a user can
 * never carry a stale scope that would widen or narrow access unexpectedly.
 */
async function applyRoleScopeRules(roleKey, rec, tx) {
  const missing = (field, message) => {
    throw unprocessable(`Invalid scope for role ${roleKey}`, [{ field, message }]);
  };
  switch (roleKey) {
    case 'SUPER_ADMIN':
    case 'DEPARTMENT_ADMIN':
      Object.assign(rec, { zone_id: null, ward_id: null, agency_id: null });
      break;
    case 'ZONE_ADMIN':
      if (!rec.zone_id) missing('zone_id', 'ZONE_ADMIN requires zone_id');
      Object.assign(rec, { ward_id: null, agency_id: null });
      break;
    case 'WARD_SUPERVISOR':
      if (!rec.ward_id) missing('ward_id', 'WARD_SUPERVISOR requires ward_id');
      rec.agency_id = null;
      await resolveZoneWard(rec, null, tx); // derives zone from ward or rejects a mismatch
      break;
    case 'AGENCY_USER':
      if (!rec.agency_id) missing('agency_id', 'AGENCY_USER requires agency_id');
      Object.assign(rec, { zone_id: null, ward_id: null });
      break;
    default:
      missing('role_key', 'Unknown role');
  }
  return rec;
}

function auditDetails(rec) {
  const { password_hash: _ph, password: _p, ...rest } = rec;
  return rest;
}

export const userService = {
  async list(query) {
    const { page, limit, search, ...filters } = query;
    const { rows, total } = await userRepository.list({ page, limit, search, filters });
    return { rows, pagination: paginationMeta(page, limit, total) };
  },

  async get(id) {
    const user = await userRepository.findById(id);
    if (!user) throw notFound('User not found');
    return user;
  },

  async create(data, ctx) {
    return withTransaction(async (tx) => {
      const role = await roleRepository.findByKey(data.role_key, tx);
      if (!role) throw unprocessable('Unknown role', [{ field: 'role_key', message: 'Unknown role' }]);
      const rec = {
        name: data.name,
        email: data.email.toLowerCase(),
        role_id: role.id,
        zone_id: data.zone_id ?? null,
        ward_id: data.ward_id ?? null,
        agency_id: data.agency_id ?? null,
        status: data.status ?? 'ACTIVE',
      };
      await applyRoleScopeRules(role.role_key, rec, tx);
      rec.password_hash = await hashPassword(data.password);
      const id = await userRepository.insert(rec, tx);
      await recordActivity(ctx, {
        action: ACTIONS.CREATE, module: MODULE, referenceId: id,
        details: { ...auditDetails(rec), role_key: role.role_key },
      }, tx);
      return userRepository.findById(id, null, tx);
    });
  },

  async update(id, data, ctx) {
    return withTransaction(async (tx) => {
      const existing = await userRepository.findById(id, null, tx);
      if (!existing) throw notFound('User not found');

      const roleKey = data.role_key ?? existing.role_key;
      const role = await roleRepository.findByKey(roleKey, tx);
      if (!role) throw unprocessable('Unknown role', [{ field: 'role_key', message: 'Unknown role' }]);

      const selfLockout = (data.status && data.status !== 'ACTIVE') || role.role_key !== 'SUPER_ADMIN';
      if (existing.id === ctx.user.id && selfLockout) {
        throw unprocessable('You cannot deactivate or demote your own account');
      }

      const rec = {
        name: data.name,
        email: data.email?.toLowerCase(),
        role_id: role.id,
        status: data.status,
        // Re-evaluate scope against the (possibly new) role using merged values.
        zone_id: data.zone_id !== undefined ? data.zone_id : existing.zone_id,
        ward_id: data.ward_id !== undefined ? data.ward_id : existing.ward_id,
        agency_id: data.agency_id !== undefined ? data.agency_id : existing.agency_id,
      };
      // When only ward changes for a ward supervisor, derive zone from the new ward.
      if (role.role_key === 'WARD_SUPERVISOR' && data.ward_id !== undefined && data.zone_id === undefined) {
        rec.zone_id = null;
      }
      await applyRoleScopeRules(role.role_key, rec, tx);
      if (data.password) rec.password_hash = await hashPassword(data.password);

      await userRepository.update(id, rec, tx);
      await recordActivity(ctx, {
        action: ACTIONS.UPDATE, module: MODULE, referenceId: id,
        details: { ...auditDetails(rec), role_key: role.role_key, password_changed: Boolean(data.password) },
      }, tx);
      return userRepository.findById(id, null, tx);
    });
  },

  async deactivate(id, ctx) {
    if (Number(id) === ctx.user.id) throw unprocessable('You cannot deactivate your own account');
    return withTransaction(async (tx) => {
      const existing = await userRepository.findById(id, null, tx);
      if (!existing) throw notFound('User not found');
      await userRepository.update(id, { status: 'INACTIVE' }, tx);
      await recordActivity(ctx, { action: ACTIONS.DEACTIVATE, module: MODULE, referenceId: id }, tx);
      return userRepository.findById(id, null, tx);
    });
  },
};
