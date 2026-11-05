import { createMasterService } from './masterService.js';
import { resolveZoneWard } from './geoScopeService.js';
import { zoneRepository } from '../repositories/zoneRepository.js';
import { wardRepository } from '../repositories/wardRepository.js';
import { agencyRepository } from '../repositories/agencyRepository.js';
import { vehicleRepository } from '../repositories/vehicleRepository.js';

export const zoneService = createMasterService({
  repo: zoneRepository,
  module: 'zones',
  label: 'Zone',
  prepare: (d) => {
    if (d.zone_code !== undefined) d.zone_code = d.zone_code.toUpperCase();
    return d;
  },
});

export const wardService = createMasterService({
  repo: wardRepository,
  module: 'wards',
  label: 'Ward',
});

export const agencyService = createMasterService({
  repo: agencyRepository,
  module: 'agencies',
  label: 'Agency',
});

/** "hr 38 ab-1234" -> "HR38AB-1234" (uppercase, whitespace removed). */
export function normaliseVehicleNumber(v) {
  return String(v).toUpperCase().replace(/\s+/g, '');
}

export const vehicleService = createMasterService({
  repo: vehicleRepository,
  module: 'vehicles',
  label: 'Vehicle',
  prepare: async (d, existing, tx) => {
    if (d.vehicle_number !== undefined) d.vehicle_number = normaliseVehicleNumber(d.vehicle_number);
    if (d.gps_device_id === '') d.gps_device_id = null;
    await resolveZoneWard(d, existing, tx);
    return d;
  },
});
