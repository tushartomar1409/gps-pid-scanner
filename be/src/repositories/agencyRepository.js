import { createCrudRepository } from './baseRepository.js';

export const agencyRepository = createCrudRepository({
  table: 'agencies',
  alias: 'a',
  select: `a.id, a.agency_name, a.contact_person, a.mobile, a.address, a.status, a.created_at, a.updated_at,
           (SELECT count(*) FROM vehicles v WHERE v.agency_id = a.id) AS vehicle_count`,
  from: 'agencies a',
  writable: ['agency_name', 'contact_person', 'mobile', 'address', 'status'],
  search: ['a.agency_name', 'a.contact_person', 'a.mobile'],
  filters: { status: 'a.status' },
  scope: { agency: 'a.id' },
  orderBy: 'a.agency_name ASC, a.id ASC',
});
