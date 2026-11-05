// GPS polling job (GUIDE #6 D).
// - chained setTimeout (runs never overlap); interval GPS_POLL_INTERVAL_SECONDS
// - single runner: pg_try_advisory_lock on a DEDICATED unpooled client held for the process lifetime
//   (Neon's pooler = PgBouncer transaction mode does not keep session advisory locks); standby
//   instances retry the lock every 60 s; a dropped lock client re-acquires
// - failures: exponential backoff with full jitter (30 s, 1 m, 2 m … capped 5 m), reset on success;
//   provider exceptions never escape (pollOnce records FAILED)
// - stop(): no new runs, waits ≤ 10 s for the in-flight run, releases the lock
import pg from 'pg';
import { env } from '../config/env.js';
import { buildConnectionConfig } from '../config/database.js';
import { logger as rootLogger } from '../utils/logger.js';
import { pollOnce, createDeviceCache } from '../services/gps/gpsTrackerService.js';

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 5 * 60_000;
export const LOCK_RETRY_MS = 60_000;

/** Advisory-lock key text — per schema, so test/perf schemas never collide with a real poller. */
export const lockKeyFor = (schema = env.DB_SCHEMA) => `gps_poll:${schema || 'public'}`;

/** Delay before the next run: the interval on success, else full-jitter exponential backoff. */
export function nextDelayMs(consecutiveFailures, intervalMs, rng = Math.random) {
  if (consecutiveFailures <= 0) return intervalMs;
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1));
  return Math.max(1000, Math.floor(rng() * ceiling)); // full jitter, never a hot loop
}

/** Default lock implementation: dedicated unpooled pg.Client holding a session advisory lock. */
export function createAdvisoryLock({ keyText = lockKeyFor(), clientFactory = () => new pg.Client(buildConnectionConfig({ unpooled: true })), onLost } = {}) {
  let client = null;
  return {
    async tryAcquire() {
      if (client) return true;
      const c = clientFactory();
      c.on('error', () => {}); // handled via 'end'
      await c.connect();
      const { rows } = await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [keyText]);
      if (!rows[0].ok) {
        await c.end().catch(() => {});
        return false;
      }
      c.on('end', () => {
        if (client === c) {
          client = null;
          onLost?.();
        }
      });
      client = c;
      return true;
    },
    held: () => client !== null,
    async release() {
      const c = client;
      client = null;
      if (!c) return;
      await c.query('SELECT pg_advisory_unlock(hashtext($1))', [keyText]).catch(() => {});
      await c.end().catch(() => {});
    },
  };
}

export class GpsPoller {
  /**
   * @param {object} deps
   * @param {{query: Function}} deps.db         query executor for runs + ingestion
   * @param {object} deps.provider               GpsProviderAdapter
   * @param {object} [deps.lock]                 { tryAcquire, held, release }
   */
  constructor({
    db, provider, lock, deviceCache = createDeviceCache(), intervalMs = env.GPS_POLL_INTERVAL_SECONDS * 1000,
    timeoutMs = env.GPS_PROVIDER_TIMEOUT_MS, logger = rootLogger, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
    rng = Math.random, lockRetryMs = LOCK_RETRY_MS, poll = pollOnce,
  }) {
    Object.assign(this, { db, provider, deviceCache, intervalMs, timeoutMs, logger, setTimeoutFn, clearTimeoutFn, rng, lockRetryMs, poll });
    this.lock = lock || createAdvisoryLock({ onLost: () => this.#onLockLost() });
    this.timer = null;
    this.inflight = null;
    this.stopped = true;
    this.consecutiveFailures = 0;
    this.lastDelayMs = null;
    this.lastSummary = null;
  }

  get isLeader() {
    return this.lock.held();
  }

  async start() {
    this.stopped = false;
    await this.#acquireOrStandby();
  }

  async #acquireOrStandby() {
    if (this.stopped) return;
    let ok = false;
    try {
      ok = await this.lock.tryAcquire();
    } catch (err) {
      this.logger.warn({ err: err.message }, 'GPS poller: lock acquisition failed');
    }
    if (ok) {
      this.logger.info({ provider: this.provider.name }, 'GPS poller: leader — polling started');
      this.#schedule(0);
    } else {
      this.logger.info('GPS poller: another instance holds the poll lock — standby, retrying in 60 s');
      this.#scheduleRaw(() => this.#acquireOrStandby(), this.lockRetryMs);
    }
  }

  #onLockLost() {
    this.logger.warn('GPS poller: lock connection lost — re-acquiring');
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = null;
    if (!this.stopped) this.#scheduleRaw(() => this.#acquireOrStandby(), 1000);
  }

  #scheduleRaw(fn, ms) {
    if (this.stopped) return;
    this.timer = this.setTimeoutFn(fn, ms);
    this.timer?.unref?.();
  }

  #schedule(ms) {
    this.lastDelayMs = ms;
    this.#scheduleRaw(async () => {
      this.timer = null;
      if (!this.isLeader) return this.#acquireOrStandby();
      await this.runOnce('SCHEDULED');
      this.#schedule(nextDelayMs(this.consecutiveFailures, this.intervalMs, this.rng));
    }, ms);
  }

  /** Runs one poll now (never concurrently with another). Never throws. */
  async runOnce(trigger = 'SCHEDULED') {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      let summary;
      try {
        summary = await this.poll({
          db: this.db, provider: this.provider, deviceCache: this.deviceCache, trigger,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // pollOnce already swallows provider errors; this guards DB failures on the run INSERT etc.
        summary = { outcome: 'FAILED', error: String(err?.message || err), trigger, provider: this.provider.name };
      }
      if (summary.outcome === 'FAILED') {
        this.consecutiveFailures++;
        this.logger.warn({ error: summary.error, consecutiveFailures: this.consecutiveFailures }, 'GPS poll failed');
      } else {
        this.consecutiveFailures = 0;
      }
      this.lastSummary = summary;
      return summary;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async stop({ waitMs = 10_000 } = {}) {
    this.stopped = true;
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = null;
    if (this.inflight) {
      await Promise.race([this.inflight, new Promise((r) => { const t = setTimeout(r, waitMs); t.unref?.(); })]);
    }
    await this.lock.release();
  }
}
