import pino from 'pino';
import { env } from '../config/env.js';

// Connection strings (postgres://user:pass@host/db) must never reach a log line, wherever they appear.
const DB_URL = /\b(postgres(?:ql)?|mysql|redis|amqp|mongodb(?:\+srv)?):\/\/[^\s'"`]+/gi;
export function scrubSecrets(s) {
  return typeof s === 'string' ? s.replace(DB_URL, '$1://[REDACTED]') : s;
}

function scrubObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return obj;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string') obj[k] = scrubSecrets(v);
    else if (v && typeof v === 'object' && !(v instanceof Date)) scrubObject(v, depth + 1);
  }
  return obj;
}

export const REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]', 'res.headers["set-cookie"]',
  'password', '*.password', '*.password_hash', 'password_hash',
  'token', '*.token', 'secret', '*.secret', 'api_key', '*.api_key', '*.apiKey', 'DATABASE_URL', '*.DATABASE_URL', '*.connectionString',
];

export const logger = pino({
  // Tests are silent unless TEST_LOG_LEVEL is set (e.g. TEST_LOG_LEVEL=error to debug a 500).
  level: env.NODE_ENV === 'test' ? process.env.TEST_LOG_LEVEL || 'silent' : env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  formatters: {
    log: (obj) => {
      scrubObject(obj);
      if (obj.err && typeof obj.err === 'object') {
        if (obj.err.message) obj.err.message = scrubSecrets(obj.err.message);
        if (obj.err.stack) obj.err.stack = scrubSecrets(obj.err.stack);
      }
      return obj;
    },
  },
  hooks: {
    // Also scrub the message string itself (logger.info('…postgres://…')).
    logMethod(args, method) {
      method.apply(this, args.map((a) => (typeof a === 'string' ? scrubSecrets(a) : a)));
    },
  },
});
