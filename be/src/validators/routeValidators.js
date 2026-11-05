import { z } from 'zod';
import { pagination, queryId, bodyId, masterStatus, text, partialUpdate } from './common.js';
import { latitude, longitude } from './pidValidators.js';

// GeoJSON LineString, coordinates in [lng, lat] order (RFC 7946), 2–10,000 positions.
const position = z
  .tuple([z.number(), z.number()])
  .refine(([lng, lat]) => lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90, {
    message: 'Each position must be [lng, lat] with lng in [-180,180] and lat in [-90,90]',
  });

export const lineString = z.strictObject({
  type: z.literal('LineString'),
  coordinates: z.array(position).min(2, 'A LineString needs at least 2 positions').max(10_000, 'At most 10,000 positions'),
});

const routeBase = z.strictObject({
  route_code: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9_-]+$/, 'Only letters, digits, _ and -'),
  route_name: text(150),
  zone_id: z.number().int().positive().optional(),
  ward_id: z.number().int().positive(),
  agency_id: bodyId.optional(),
  default_vehicle_id: bodyId.optional(),
  start_latitude: latitude.nullable().optional(),
  start_longitude: longitude.nullable().optional(),
  end_latitude: latitude.nullable().optional(),
  end_longitude: longitude.nullable().optional(),
  route_geometry: lineString.nullable().optional(),
  status: masterStatus.optional(),
});

const pairs = (o) =>
  (o.start_latitude == null) === (o.start_longitude == null) && (o.end_latitude == null) === (o.end_longitude == null);
const pairMsg = { message: 'Start/end points need both latitude and longitude, or neither', path: ['start_latitude'] };

export const routeSchemas = {
  list: z.object({
    ...pagination,
    status: masterStatus.optional(),
    zone_id: queryId,
    ward_id: queryId,
    agency_id: queryId,
  }),
  create: routeBase.refine(pairs, pairMsg),
  update: partialUpdate(routeBase).refine(pairs, pairMsg),
  pidsQuery: z.object({ page: pagination.page, limit: pagination.limit }),
  assignPids: z.strictObject({
    pid_ids: z.array(z.number().int().positive()).min(1).max(5000, 'At most 5000 PIDs per call'),
    mode: z.enum(['add', 'replace', 'remove']),
  }),
};
