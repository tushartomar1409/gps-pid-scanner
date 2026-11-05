import { z } from 'zod';
import { pagination, queryId, bodyId, masterStatus, text, optionalText, partialUpdate } from './common.js';

const code = z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/, 'Only letters, digits, _ and -');
const mobile = z
  .string().trim()
  .regex(/^[0-9+\- ]{7,15}$/, 'Mobile must be 7-15 digits (may include +, -, space)')
  .nullable().optional();

// ---------- zones ----------
const zoneBody = z.strictObject({
  zone_code: code,
  zone_name: text(100),
  status: masterStatus.optional(),
});
export const zoneSchemas = {
  list: z.object({ ...pagination, status: masterStatus.optional() }),
  create: zoneBody,
  update: partialUpdate(zoneBody),
};

// ---------- wards ----------
const wardBody = z.strictObject({
  zone_id: z.number().int().positive(),
  ward_number: text(20),
  ward_name: text(100),
  status: masterStatus.optional(),
});
export const wardSchemas = {
  list: z.object({ ...pagination, status: masterStatus.optional(), zone_id: queryId }),
  create: wardBody,
  update: partialUpdate(wardBody),
};

// ---------- agencies ----------
const agencyBody = z.strictObject({
  agency_name: text(150),
  contact_person: optionalText(100),
  mobile,
  address: optionalText(500),
  status: masterStatus.optional(),
});
export const agencySchemas = {
  list: z.object({ ...pagination, status: masterStatus.optional() }),
  create: agencyBody,
  update: partialUpdate(agencyBody),
};

// ---------- vehicles ----------
const vehicleStatus = z.enum(['ACTIVE', 'INACTIVE', 'MAINTENANCE']);
const vehicleBody = z.strictObject({
  vehicle_number: z
    .string()
    .transform((v) => v.toUpperCase().replace(/\s+/g, ''))
    .pipe(z.string().min(4).max(20).regex(/^[A-Z0-9-]+$/, 'Only letters, digits and -')),
  vehicle_type: text(50),
  gps_device_id: z.string().trim().max(64).nullable().optional(),
  gps_provider: optionalText(50),
  agency_id: bodyId.optional(),
  zone_id: bodyId.optional(),
  ward_id: bodyId.optional(),
  default_route_id: bodyId.optional(),
  status: vehicleStatus.optional(),
});
export const vehicleSchemas = {
  list: z.object({
    ...pagination,
    status: vehicleStatus.optional(),
    zone_id: queryId,
    ward_id: queryId,
    agency_id: queryId,
    vehicle_type: z.string().trim().max(50).optional(),
  }),
  create: vehicleBody,
  update: partialUpdate(vehicleBody),
};
