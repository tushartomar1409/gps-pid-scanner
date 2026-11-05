// Process entry point: HTTP server (+ Socket.IO and jobs in later phases).
import http from 'node:http';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { pool, closePool } from './config/database.js';
import { logger } from './utils/logger.js';

const app = createApp();
const server = http.createServer(app);

async function start() {
  await pool.query('SELECT 1'); // fail fast if the DB is unreachable
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'API server listening'));
}

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  server.close(async () => {
    await closePool().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
