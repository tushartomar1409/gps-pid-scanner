import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  // Tests are silent unless TEST_LOG_LEVEL is set (e.g. TEST_LOG_LEVEL=error to debug a 500).
  level: env.NODE_ENV === 'test' ? process.env.TEST_LOG_LEVEL || 'silent' : env.LOG_LEVEL,
  redact: ['req.headers.authorization', 'password', '*.password', '*.password_hash'],
});
