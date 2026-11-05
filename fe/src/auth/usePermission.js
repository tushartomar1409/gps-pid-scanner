import { useCallback } from 'react';
import { useAuth } from './AuthContext.jsx';

/** Pure check — '*' grants everything. */
export function hasPermission(user, permission) {
  if (!permission) return true;
  const perms = user?.permissions || [];
  return perms.includes('*') || perms.includes(permission);
}

/** const can = usePermission(); can('vehicles:write') */
export function usePermission() {
  const { user } = useAuth();
  return useCallback((permission) => hasPermission(user, permission), [user]);
}
