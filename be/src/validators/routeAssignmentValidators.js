import { z } from 'zod';
import { pagination, queryId } from './common.js';

const isoDate = z.iso.date('Use YYYY-MM-DD');
// Timestamps must carry an explicit offset (e.g. 2026-11-06T06:00:00+05:30) — no ambiguous local times.
const isoDateTime = z.iso.datetime({ offset: true, message: 'Use an ISO-8601 timestamp with offset, e.g. 2026-11-06T06:00:00+05:30' });

const shiftRules = (o) =>
  (o.shift_start == null) === (o.shift_end == null) &&
  (o.shift_start == null || Date.parse(o.shift_end) > Date.parse(o.shift_start));
const shiftMsg = { message: 'Provide both shift_start and shift_end (end after start), or neither', path: ['shift_start'] };

const itemBase = z.strictObject({
  route_id: z.number().int().positive(),
  vehicle_id: z.number().int().positive(),
  operational_date: isoDate,
  shift_start: isoDateTime.nullable().optional(),
  shift_end: isoDateTime.nullable().optional(),
  allow_past: z.boolean().optional(),
});
const item = itemBase.refine(shiftRules, shiftMsg);

export const RA_STATUSES = ['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED'];
export const VISIT_STATUSES = ['GPS_VISIT_CONFIRMED', 'GPS_VISIT_CANDIDATE', 'NOT_VISITED', 'GPS_DATA_UNAVAILABLE', 'UNASSIGNED_PID'];

export const routeAssignmentSchemas = {
  create: item,
  bulk: z.union([
    z.strictObject({ assignments: z.array(item).min(1).max(500, 'At most 500 assignments per bulk call') }),
    z.strictObject({
      copy_from_date: isoDate,
      to_date: isoDate,
      zone_id: z.number().int().positive().optional(),
      ward_id: z.number().int().positive().optional(),
      allow_past: z.boolean().optional(),
    }).refine((o) => o.copy_from_date !== o.to_date, { message: 'to_date must differ from copy_from_date', path: ['to_date'] }),
  ]),
  list: z.object({
    ...pagination,
    operational_date: isoDate.optional(),
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
    vehicle_id: queryId,
    route_id: queryId,
    zone_id: queryId,
    ward_id: queryId,
    agency_id: queryId,
    status: z.enum(RA_STATUSES).optional(),
  }),
  get: z.object({ page: pagination.page, limit: pagination.limit, visit_status: z.enum(VISIT_STATUSES).optional() }),
};
