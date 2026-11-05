import { createCrudRepository } from './baseRepository.js';

export const zoneRepository = createCrudRepository({
  table: 'zones',
  alias: 'z',
  select: `z.id, z.zone_code, z.zone_name, z.status, z.created_at, z.updated_at,
           (SELECT count(*) FROM wards w WHERE w.zone_id = z.id) AS ward_count`,
  from: 'zones z',
  writable: ['zone_code', 'zone_name', 'status'],
  search: ['z.zone_code', 'z.zone_name'],
  filters: { status: 'z.status' },
  scope: { zone: 'z.id' },
  orderBy: 'z.zone_name ASC, z.id ASC',
});
