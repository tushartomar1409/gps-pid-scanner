import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';
import { sendError } from '../utils/responseHandler.js';

/** Login limiter: N requests / minute / IP (default 5). A new instance per app keeps tests isolated. */
export function createLoginLimiter({ limit = env.LOGIN_RATE_LIMIT_PER_MIN, windowMs = 60_000 } = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) =>
      sendError(res, { status: 429, message: 'Too many login attempts. Please try again in a minute.' }),
  });
}
