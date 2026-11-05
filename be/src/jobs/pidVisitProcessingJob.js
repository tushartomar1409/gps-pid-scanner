// PID detection worker + daily finalization (GUIDE #7 B, E). Leader-only via its own advisory lock
// ('pid_detect:<schema>'), separate from the GPS poll lock.
// - gpsEvents 'ingested' / 'detection:wake' are WAKE-UP signals only, coalesced: while a run is in
//   flight at most one more run is queued. The source of truth is gps_locations.processed_at IS NULL.
// - catch-up timer every DETECTION_CATCHUP_SECONDS covers late points, crashes, disabled periods
// - finalizer every DETECTION_FINALIZE_MINUTES (default 15)
import { env } from '../config/env.js';
import { pool as defaultPool } from '../config/database.js';
import { logger as rootLogger } from '../utils/logger.js';
import { gpsEvents } from '../services/gps/gpsEvents.js';
import { loadDetectionSettings } from '../services/settingsDefinitions.js';
import { runDetection } from '../services/pidDetectionService.js';
import { finalizeDue } from '../services/coverageFinalizationService.js';
import { createAdvisoryLock, LOCK_RETRY_MS } from './gpsPollingJob.js';

export const detectLockKeyFor = (schema = env.DB_SCHEMA) => `pid_detect:${schema || 'public'}`;

export class PidVisitWorker {
  constructor({
    pool = defaultPool, lock, logger = rootLogger, events = gpsEvents, batchSize = env.DETECTION_BATCH_SIZE,
    catchupMs = env.DETECTION_CATCHUP_SECONDS * 1000, finalizeMs = env.DETECTION_FINALIZE_MINUTES * 60_000,
    setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  } = {}) {
    Object.assign(this, { pool, logger, events, batchSize, catchupMs, finalizeMs, setIntervalFn, clearIntervalFn });
    this.lock = lock || createAdvisoryLock({ keyText: detectLockKeyFor(), onLost: () => this.#onLost() });
    this.inflight = null;
    this.queued = false;
    this.stopped = true;
    this.timers = [];
    this.lastRun = null;
    this.onWake = () => this.wake();
  }

  get isLeader() {
    return this.lock.held();
  }

  async start() {
    this.stopped = false;
    this.events.on('ingested', this.onWake);
    this.events.on('detection:wake', this.onWake);
    await this.#acquire();
    this.timers.push(this.setIntervalFn(() => this.wake(), this.catchupMs));
    this.timers.push(this.setIntervalFn(() => this.finalize().catch(() => {}), this.finalizeMs));
    this.timers.forEach((t) => t?.unref?.());
  }

  async #acquire() {
    let ok = false;
    try {
      ok = await this.lock.tryAcquire();
    } catch (err) {
      this.logger.warn({ err: err.message }, 'PID detection: lock acquisition failed');
    }
    if (ok) {
      this.logger.info('PID detection: leader');
      this.wake(); // drain any backlog immediately
    } else if (!this.stopped) {
      this.logger.info('PID detection: standby (another instance holds the lock)');
      const t = setTimeout(() => this.#acquire(), LOCK_RETRY_MS);
      t.unref?.();
    }
  }

  #onLost() {
    this.logger.warn('PID detection: lock lost — re-acquiring');
    if (!this.stopped) setTimeout(() => this.#acquire(), 1000).unref?.();
  }

  /** Coalesced trigger: never more than one run in flight + one queued. */
  wake() {
    if (this.stopped || !this.isLeader) return this.inflight;
    if (this.inflight) {
      this.queued = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      /* eslint-disable no-await-in-loop -- a queued wake re-runs only after the current run finished */
      do {
        this.queued = false;
        try {
          const settings = await loadDetectionSettings(this.pool); // once per run
          this.lastRun = await runDetection(this.pool, settings, { batchSize: this.batchSize });
          if (this.lastRun.points) this.logger.info(this.lastRun, 'PID detection run');
        } catch (err) {
          this.logger.error({ err: err.message }, 'PID detection run failed (points stay unprocessed; retried on next wake)');
        }
      } while (this.queued && !this.stopped);
      /* eslint-enable no-await-in-loop */
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async finalize() {
    if (this.stopped || !this.isLeader) return null;
    try {
      const r = await finalizeDue(this.pool, await loadDetectionSettings(this.pool));
      if (r.finalized) this.logger.info(r, 'Daily coverage finalization');
      return r;
    } catch (err) {
      this.logger.error({ err: err.message }, 'Finalization failed');
      return null;
    }
  }

  async stop({ waitMs = 10_000 } = {}) {
    this.stopped = true;
    this.events.off('ingested', this.onWake);
    this.events.off('detection:wake', this.onWake);
    this.timers.forEach((t) => this.clearIntervalFn(t));
    this.timers = [];
    if (this.inflight) await Promise.race([this.inflight, new Promise((r) => setTimeout(r, waitMs).unref?.())]);
    await this.lock.release();
  }
}
