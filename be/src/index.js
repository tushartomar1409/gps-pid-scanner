// Process entry point: HTTP server + Socket.IO + (optional) GPS polling, detection worker, daily report archive.
import http from 'node:http';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { pool, closePool } from './config/database.js';
import { logger } from './utils/logger.js';
import { getProvider, getPoller, startGpsPolling, stopGpsPolling } from './services/gps/gpsRuntime.js';
import { registerJob } from './services/opsService.js';
import { PidVisitWorker } from './jobs/pidVisitProcessingJob.js';
import { attachRealtime } from './realtime/socketServer.js';
import { startReportArchive } from './services/reports/archiveService.js';
import { startGpsLifecycle } from './services/gps/gpsLifecycleService.js';

const app = createApp();
const server = http.createServer(app);
// GUIDE #11 C7 (slow-loris): headers must arrive within 20 s, a whole request (incl. a 10 MB import upload)
// within 120 s. requestTimeout covers RECEIVING the request only, so long streamed exports are unaffected.
server.headersTimeout = 20_000;
server.requestTimeout = 120_000;
server.keepAliveTimeout = 65_000; // > typical nginx/ALB idle timeout (60 s) to avoid 502s on reused connections
const realtime = attachRealtime(server); // Socket.IO on /socket.io (not in app.js: tests build the app alone)

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
  if (env.REPORTS_ARCHIVE_ENABLED ?? env.DETECTION_WORKER_ENABLED ?? env.GPS_POLL_ENABLED) {
    reportArchive = startReportArchive({ logger });
    logger.info({ at: env.REPORTS_DAILY_TIME, dir: env.REPORTS_DIR }, 'Daily report archive scheduled');
  } else logger.info('Daily report archive disabled');
  // Partition upkeep must run even with polling off (next month's partition, retention); it is lock-guarded.
  if (env.GPS_LIFECYCLE_ENABLED) gpsLifecycle = startGpsLifecycle({ logger });
  else logger.warn('GPS lifecycle job disabled (GPS_LIFECYCLE_ENABLED=false): partitions are not pre-created');

  // Ops details (GUIDE #11 E): what runs on THIS instance and whether it holds the leader lock.
  registerJob('gps_poller', () => ({ enabled: env.GPS_POLL_ENABLED, leader: Boolean(getPoller()?.isLeader), provider: env.GPS_PROVIDER }));
  registerJob('detection_worker', () => ({ enabled: Boolean(detectionWorker), leader: Boolean(detectionWorker?.isLeader) }));
  registerJob('report_archive', () => ({ enabled: Boolean(reportArchive), daily_time: env.REPORTS_DAILY_TIME }));
  registerJob('gps_lifecycle', () => ({ enabled: Boolean(gpsLifecycle) }));
}
let reportArchive = null;
let gpsLifecycle = null;
let detectionWorker = null;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  setTimeout(() => process.exit(1), 15_000).unref();
  await stopGpsPolling().catch((err) => logger.warn({ err: err.message }, 'GPS poller stop failed')); // waits ≤ 10 s
  await detectionWorker?.stop().catch((err) => logger.warn({ err: err.message }, 'Detection worker stop failed'));
  await reportArchive?.stop().catch(() => {});
  await gpsLifecycle?.stop().catch(() => {});
  await realtime.close().catch(() => {});
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
