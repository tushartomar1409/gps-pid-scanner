import { createCrudRepository } from './baseRepository.js';

export const wardRepository = createCrudRepository({
  table: 'wards',
  alias: 'w',
  select: `w.id, w.zone_id, z.zone_name, z.zone_code, w.ward_number, w.ward_name, w.status,
           w.created_at, w.updated_at`,
  from: 'wards w JOIN zones z ON z.id = w.zone_id',
  writable: ['zone_id', 'ward_number', 'ward_name', 'status'],
  search: ['w.ward_number', 'w.ward_name'],
  filters: { status: 'w.status', zone_id: 'w.zone_id' },
  scope: { zone: 'w.zone_id', ward: 'w.id' },
  orderBy: 'z.zone_name ASC, w.ward_number ASC, w.id ASC',
});
