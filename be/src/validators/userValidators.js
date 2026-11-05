import { z } from 'zod';
import { pagination, queryId, bodyId, text, partialUpdate } from './common.js';

export const ROLE_KEYS = ['SUPER_ADMIN', 'DEPARTMENT_ADMIN', 'ZONE_ADMIN', 'WARD_SUPERVISOR', 'AGENCY_USER'];
const userStatus = z.enum(['ACTIVE', 'INACTIVE', 'LOCKED']);

const email = z.string().trim().toLowerCase().pipe(z.email('Invalid email address').max(254));

// bcrypt only uses the first 72 bytes, so cap there.
const password = z
  .string()
  .min(10, 'Password must be at least 10 characters') // GUIDE #11 C2 (+ email / common checks in userService)
  .max(72, 'Password must be at most 72 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a digit');

const userBody = z.strictObject({
  name: text(100),
  email,
  password,
  role_key: z.enum(ROLE_KEYS),
  zone_id: bodyId.optional(),
  ward_id: bodyId.optional(),
  agency_id: bodyId.optional(),
  status: userStatus.optional(),
});

export const userSchemas = {
  list: z.object({
    ...pagination,
    status: userStatus.optional(),
    role_key: z.enum(ROLE_KEYS).optional(),
    zone_id: queryId,
    agency_id: queryId,
  }),
  create: userBody,
  update: partialUpdate(userBody),
};

export const loginSchema = z.strictObject({
  email,
  password: z.string().min(1, 'Password is required').max(200),
});
