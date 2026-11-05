import { createCrudRepository } from './baseRepository.js';

export const vehicleRepository = createCrudRepository({
  table: 'vehicles',
  alias: 'v',
  select: `v.id, v.vehicle_number, v.vehicle_type, v.gps_device_id, v.gps_provider,
           v.agency_id, a.agency_name, v.zone_id, z.zone_name, v.ward_id, w.ward_name, w.ward_number,
           v.default_route_id, r.route_code AS default_route_code, v.status, v.created_at, v.updated_at`,
  from: `vehicles v
         LEFT JOIN agencies a ON a.id = v.agency_id
         LEFT JOIN zones z    ON z.id = v.zone_id
         LEFT JOIN wards w    ON w.id = v.ward_id
         LEFT JOIN routes r   ON r.id = v.default_route_id`,
  writable: ['vehicle_number', 'vehicle_type', 'gps_device_id', 'gps_provider', 'agency_id', 'zone_id',
    'ward_id', 'default_route_id', 'status'],
  search: ['v.vehicle_number', 'v.gps_device_id', 'v.vehicle_type'],
  filters: {
    status: 'v.status', zone_id: 'v.zone_id', ward_id: 'v.ward_id', agency_id: 'v.agency_id',
    vehicle_type: 'v.vehicle_type',
  },
  scope: { zone: 'v.zone_id', ward: 'v.ward_id', agency: 'v.agency_id' },
  orderBy: 'v.vehicle_number ASC',
});
