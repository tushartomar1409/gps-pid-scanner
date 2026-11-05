import { z } from 'zod';
import { pagination, queryId, masterStatus, optionalText, partialUpdate } from './common.js';

export const PID_NUMBER_RE = /^[A-Z0-9][A-Z0-9/_.-]{0,49}$/;
export const MOBILE_RE = /^[0-9+\- ]{7,15}$/;
export const COORD_STATUSES = ['MISSING', 'IMPORTED', 'MANUALLY_CORRECTED', 'VERIFIED'];

export const latitude = z.number().min(-90, 'Latitude must be between -90 and 90').max(90, 'Latitude must be between -90 and 90');
export const longitude = z.number().min(-180, 'Longitude must be between -180 and 180').max(180, 'Longitude must be between -180 and 180');

export const pidNumber = z
  .string()
  .transform((v) => v.trim().toUpperCase())
  .pipe(z.string().regex(PID_NUMBER_RE, '1–50 chars: letters, digits, / _ . -'));

const pidBase = z.strictObject({
  pid_number: pidNumber,
  owner_name: optionalText(150),
  mobile: z.string().trim().regex(MOBILE_RE, 'Mobile must be 7-15 digits (may include +, -, space)').nullable().optional(),
  address: optionalText(500),
  zone_id: z.number().int().positive().optional(),
  ward_id: z.number().int().positive(),
  latitude: latitude.nullable().optional(),
  longitude: longitude.nullable().optional(),
  status: masterStatus.optional(),
});

const bothOrNeither = (o) => (o.latitude == null) === (o.longitude == null);

const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true').optional();

export const pidSchemas = {
  list: z.object({
    ...pagination,
    status: masterStatus.optional(),
    zone_id: queryId,
    ward_id: queryId,
    route_id: queryId,
    coord_status: z.enum(COORD_STATUSES).optional(),
    has_coords: boolQuery,
  }),
  create: pidBase.refine(bothOrNeither, { message: 'Provide both latitude and longitude, or neither', path: ['latitude'] }),
  // Coordinates change only via PATCH /:id/coordinates (audited).
  update: partialUpdate(pidBase.omit({ latitude: true, longitude: true })),
  coordinates: z.strictObject({ latitude, longitude, verified: z.boolean().optional() }),
  map: z.object({
    bbox: z
      .string()
      .transform((s, ctx) => {
        const parts = s.split(',').map((x) => Number(x.trim()));
        const [minLng, minLat, maxLng, maxLat] = parts;
        const ok = parts.length === 4 && parts.every(Number.isFinite)
          && minLng >= -180 && maxLng <= 180 && minLat >= -90 && maxLat <= 90 && minLng < maxLng && minLat < maxLat;
        if (!ok) {
          ctx.addIssue({ code: 'custom', message: 'bbox must be minLng,minLat,maxLng,maxLat with min < max' });
          return z.NEVER;
        }
        return { minLng, minLat, maxLng, maxLat };
      }),
    zone_id: queryId,
    ward_id: queryId,
    route_id: queryId,
    limit: z.coerce.number().int().min(1).max(10_000).default(5000),
  }),
};
