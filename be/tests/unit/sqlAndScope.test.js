import { describe, it, expect } from 'vitest';
import { SqlWhere, escapeLike, paginationMeta } from '../../src/utils/sql.js';
import { applyScope, scopeFromUser } from '../../src/middleware/scopeMiddleware.js';
import { normaliseVehicleNumber } from '../../src/services/masterServices.js';

const cols = { zone: 'v.zone_id', ward: 'v.ward_id', agency: 'v.agency_id' };

describe('SqlWhere', () => {
  it('numbers placeholders and never interpolates values', () => {
    const w = new SqlWhere().eq('a', 1).eq('b', undefined).add('c BETWEEN ? AND ?', 2, 3).search(['x', 'y'], "o'r%");
    expect(w.toSql()).toBe('WHERE a = $1 AND c BETWEEN $2 AND $3 AND (x::text ILIKE $4 OR y::text ILIKE $4)');
    expect(w.params).toEqual([1, 2, 3, "%o'r\\%%"]);
  });
  it('returns empty string with no clauses', () => expect(new SqlWhere().toSql()).toBe(''));
  it('escapes LIKE wildcards', () => expect(escapeLike('a_b%c\\')).toBe('a\\_b\\%c\\\\'));
  it('builds pagination meta', () => expect(paginationMeta(2, 20, 41)).toEqual({ page: 2, limit: 20, total: 41, total_pages: 3 }));
});

describe('scope', () => {
  const build = (user) => applyScope(new SqlWhere(), scopeFromUser(user), cols);

  it('is unrestricted for SUPER_ADMIN and DEPARTMENT_ADMIN', () => {
    expect(build({ role_key: 'SUPER_ADMIN' }).toSql()).toBe('');
    expect(build({ role_key: 'DEPARTMENT_ADMIN' }).toSql()).toBe('');
  });
  it('restricts ZONE_ADMIN by zone', () => {
    const w = build({ role_key: 'ZONE_ADMIN', zone_id: 7 });
    expect(w.toSql()).toBe('WHERE v.zone_id = $1');
    expect(w.params).toEqual([7]);
  });
  it('restricts WARD_SUPERVISOR by ward, falling back to zone when no ward column', () => {
    expect(build({ role_key: 'WARD_SUPERVISOR', ward_id: 3, zone_id: 1 }).toSql()).toBe('WHERE v.ward_id = $1');
    const w = applyScope(new SqlWhere(), scopeFromUser({ role_key: 'WARD_SUPERVISOR', ward_id: 3, zone_id: 1 }), { zone: 'z.id' });
    expect(w.params).toEqual([1]);
  });
  it('restricts AGENCY_USER by agency and ignores resources without agency column', () => {
    expect(build({ role_key: 'AGENCY_USER', agency_id: 9 }).toSql()).toBe('WHERE v.agency_id = $1');
    expect(applyScope(new SqlWhere(), scopeFromUser({ role_key: 'AGENCY_USER', agency_id: 9 }), { zone: 'z.id' }).toSql()).toBe('');
  });
  it('fails closed when a scoped role has no scope id or role is unknown', () => {
    expect(build({ role_key: 'AGENCY_USER', agency_id: null }).toSql()).toBe('WHERE FALSE');
    expect(build({ role_key: 'SOMETHING_ELSE' }).toSql()).toBe('WHERE FALSE');
  });
});

describe('normaliseVehicleNumber', () => {
  it('uppercases and strips whitespace', () => expect(normaliseVehicleNumber(' hr 38 ab\t1234 ')).toBe('HR38AB1234'));
});
