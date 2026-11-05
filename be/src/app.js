// Express app factory — no listen() here so supertest can drive it directly.
import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { createApiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorMiddleware.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,100}$/;

/** x-request-id: honour a well-formed incoming id (from nginx / the client), else generate one (GUIDE #11 C6). */
export function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
  req.id = id;
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1); // behind nginx: real client IP for rate limiting/logs

  app.use(requestId);
  // The API only ever returns JSON / file downloads, so its own CSP is the strictest possible.
  // The SPA's CSP is served by nginx (workflow-docs/security-review.md) and by `vite preview` in e2e.
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    strictTransportSecurity: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  }));
  // Content-Disposition is exposed so a cross-origin frontend can read the export filename (GUIDE #10 D3).
  app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()), credentials: true, exposedHeaders: ['Content-Disposition', 'X-Request-Id'] }));
  app.use(express.json({ limit: '1mb' })); // GUIDE #11 C7: JSON bodies capped at 1 MB (413 above)
  app.use(pinoHttp({ logger, autoLogging: env.NODE_ENV !== 'test', genReqId: (req) => req.id }));

  app.use('/api', createApiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
