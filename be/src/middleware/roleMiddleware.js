import { forbidden, unauthorized } from '../utils/errors.js';

export function hasPermission(user, permission) {
  const perms = user?.permissions || [];
  return perms.includes('*') || perms.includes(permission);
}

/** requirePermission('vehicles:write') — all listed permissions are required. */
export function requirePermission(...permissions) {
  return (req, _res, next) => {
    if (!req.user) throw unauthorized();
    if (!permissions.every((p) => hasPermission(req.user, p))) throw forbidden();
    next();
  };
}

/** requireRole('SUPER_ADMIN') — any listed role is accepted. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role_key)) throw forbidden();
    next();
  };
}
