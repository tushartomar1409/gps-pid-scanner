import { activityLogRepository } from '../repositories/activityLogRepository.js';

export const ACTIONS = Object.freeze({
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DEACTIVATE: 'DEACTIVATE',
  LOGIN: 'LOGIN',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
});

/** ctx = { user, ip }. Pass a transaction client as executor to log atomically with the write. */
export function recordActivity(ctx, { action, module, referenceId, details }, executor) {
  return activityLogRepository.insert(
    { userId: ctx?.user?.id ?? null, action, module, referenceId, details, ip: ctx?.ip },
    executor,
  );
}
