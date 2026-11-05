// Process-wide GPS runtime: one provider instance and (optionally) one poller.
// index.js calls startGpsPolling() only when GPS_POLL_ENABLED=true; app.js never starts it (tests).
import { env } from '../../config/env.js';
import { db } from '../../config/database.js';
import { createProvider } from './providers/index.js';
import { createDeviceCache, pollOnce } from './gpsTrackerService.js';
import { GpsPoller, createAdvisoryLock } from '../../jobs/gpsPollingJob.js';
import { conflict } from '../../utils/errors.js';

let provider = null;
let poller = null;

export function getProvider() {
  if (!provider) provider = createProvider(env.GPS_PROVIDER, { db });
  return provider;
}

/** For tests / perf: inject a provider instance. */
export function setProviderForTesting(p) {
  provider = p;
}

export async function startGpsPolling() {
  if (poller) return poller;
  poller = new GpsPoller({ db, provider: getProvider() });
  await poller.start();
  return poller;
}

export async function stopGpsPolling() {
  if (!poller) return;
  const p = poller;
  poller = null;
  await p.stop();
}

export const getPoller = () => poller;

/**
 * POST /api/gps/poll-now: one immediate run through the lock-aware path.
 * - this process is the polling leader -> reuse its poller (never overlaps a scheduled run)
 * - polling disabled here -> take the advisory lock briefly; 409 if another instance holds it
 */
export async function pollNow() {
  if (poller) {
    if (!poller.isLeader) throw conflict('This instance is a standby poller; another instance holds the GPS poll lock');
    return poller.runOnce('MANUAL');
  }
  const lock = createAdvisoryLock();
  if (!(await lock.tryAcquire())) throw conflict('Another instance is polling right now (GPS poll lock held)');
  try {
    return await pollOnce({
      db, provider: getProvider(), deviceCache: createDeviceCache(), trigger: 'MANUAL',
      signal: AbortSignal.timeout(env.GPS_PROVIDER_TIMEOUT_MS),
    });
  } finally {
    await lock.release();
  }
}
