import { z } from 'zod';

export const MAX_PAGE_LIMIT = 100;

export const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Positive integer id from a query string. */
export const queryId = z.coerce.number().int().positive().optional();

/** Positive integer id in a JSON body; null clears the reference. */
export const bodyId = z.number().int().positive().nullable();

export const masterStatus = z.enum(['ACTIVE', 'INACTIVE']);

export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(20),
  search: z.string().trim().max(100).optional(),
};

export const text = (max, min = 1) => z.string().trim().min(min).max(max);
export const optionalText = (max) => z.string().trim().max(max).nullable().optional();

/** Partial update schema: all optional, but at least one field. */
export function partialUpdate(schema) {
  return schema.partial().refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' });
}
