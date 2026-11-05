// Row-level data scope (flow.txt §4, §20): turns req.user into WHERE fragments.
//
//   SUPER_ADMIN / DEPARTMENT_ADMIN -> unrestricted
//   ZONE_ADMIN       -> zone column = user.zone_id
//   WARD_SUPERVISOR  -> ward column = user.ward_id (falls back to zone column if the resource has no ward)
//   AGENCY_USER      -> agency column = user.agency_id
//
// `columns` describes which scope columns a resource has, e.g. { zone: 'v.zone_id', ward: 'v.ward_id',
// agency: 'v.agency_id' }. If a resource has no column for the user's scope dimension, it is shared
// reference data for that role (e.g. zones/wards for agency users) and is not restricted.

const UNRESTRICTED = new Set(['SUPER_ADMIN', 'DEPARTMENT_ADMIN']);

/** Derive a scope descriptor from the authenticated user. */
export function scopeFromUser(user) {
  if (!user || UNRESTRICTED.has(user.role_key)) return { unrestricted: true };
  return {
    unrestricted: false,
    role_key: user.role_key,
    zone_id: user.zone_id ?? null,
    ward_id: user.ward_id ?? null,
    agency_id: user.agency_id ?? null,
  };
}

/** Apply scope to a SqlWhere. A scoped role missing its required id sees nothing (fail closed). */
export function applyScope(where, scope, columns = {}) {
  if (!scope || scope.unrestricted) return where;
  const restrict = (column, value) => {
    if (value === null || value === undefined) where.add('FALSE');
    else where.add(`${column} = ?`, value);
  };
  switch (scope.role_key) {
    case 'ZONE_ADMIN':
      if (columns.zone) restrict(columns.zone, scope.zone_id);
      break;
    case 'WARD_SUPERVISOR':
      if (columns.ward) restrict(columns.ward, scope.ward_id);
      else if (columns.zone) restrict(columns.zone, scope.zone_id);
      break;
    case 'AGENCY_USER':
      if (columns.agency) restrict(columns.agency, scope.agency_id);
      break;
    default:
      where.add('FALSE'); // unknown role: fail closed
  }
  return where;
}

/** Express middleware: attaches req.scope for controllers/services. */
export function attachScope(req, _res, next) {
  req.scope = scopeFromUser(req.user);
  next();
}
