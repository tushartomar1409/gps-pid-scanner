// Process entry point: HTTP server + (optional) GPS polling job. Socket.IO arrives in Phase 5.
import http from 'node:http';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { pool, closePool } from './config/database.js';
import { logger } from './utils/logger.js';
import { getProvider, startGpsPolling, stopGpsPolling } from './services/gps/gpsRuntime.js';
import { PidVisitWorker } from './jobs/pidVisitProcessingJob.js';

const app = createApp();
const server = http.createServer(app);

async function start() {
  await pool.query('SELECT 1'); // fail fast if the DB is unreachable
  getProvider(); // fail fast on an unknown GPS_PROVIDER (or the simulator in production)
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'API server listening'));
  if (env.GPS_POLL_ENABLED) await startGpsPolling();
  else logger.info('GPS polling disabled (GPS_POLL_ENABLED=false)');
  if (env.DETECTION_WORKER_ENABLED ?? env.GPS_POLL_ENABLED) {
    detectionWorker = new PidVisitWorker();
    await detectionWorker.start();
  } else logger.info('PID detection worker disabled');
}
let detectionWorker = null;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  setTimeout(() => process.exit(1), 15_000).unref();
  await stopGpsPolling().catch((err) => logger.warn({ err: err.message }, 'GPS poller stop failed')); // waits ≤ 10 s
  await detectionWorker?.stop().catch((err) => logger.warn({ err: err.message }, 'Detection worker stop failed'));
  server.close(async () => {
    await closePool().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Last line of defence: log, don't die, on stray async errors (provider code is already guarded).
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
