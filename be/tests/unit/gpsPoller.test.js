import { describe, it, expect, vi } from 'vitest';
import { GpsPoller, nextDelayMs, BACKOFF_CAP_MS } from '../../src/jobs/gpsPollingJob.js';
import { pollOnce, createDeviceCache } from '../../src/services/gps/gpsTrackerService.js';
import { deriveProviderState } from '../../src/services/gps/gpsReadService.js';

const silent = { info() {}, warn() {}, error() {} };
const fakeLock = () => ({ ok: true, tryAcquire: vi.fn(async () => true), held: () => true, release: vi.fn(async () => {}) });

/** In-memory db that answers the queries pollOnce makes (no Postgres). */
function fakeDb() {
  const runs = [];
  return {
    runs,
    async query(sql, params) {
      if (sql.includes('INSERT INTO gps_poll_runs')) { runs.push({ id: runs.length + 1, provider: params[0] }); return { rows: [{ id: runs.length }] }; }
      if (sql.includes('FROM vehicles WHERE gps_device_id')) return { rows: [{ id: 1, gps_device_id: 'D1', status: 'ACTIVE' }] };
      if (sql.startsWith('UPDATE gps_poll_runs')) { Object.assign(runs[params[0] - 1], { outcome: params[1], error: params[6] }); return { rows: [] }; }
      return { rows: [{ inserted_ids: ['1'], vehicle_ids: [1], latest_updated: 1 }] };
    },
  };
}
const okProvider = () => ({
  name: 'fake',
  fetchLatest: vi.fn(async () => [{ d: 'D1' }]),
  normalize: () => ({ ok: { device_id: 'D1', latitude: 28.4, longitude: 77.3, speed: 1, ignition: true, recorded_at: new Date(), provider_status: 'x', raw: {} } }),
});

describe('nextDelayMs', () => {
  it('uses the interval on success and capped full-jitter exponential backoff on failures', () => {
    expect(nextDelayMs(0, 60_000, () => 0.5)).toBe(60_000);
    expect(nextDelayMs(1, 60_000, () => 0.999)).toBeLessThan(30_000);
    expect(nextDelayMs(2, 60_000, () => 0.999)).toBeGreaterThan(59_000);
    expect(nextDelayMs(3, 60_000, () => 0.999)).toBeGreaterThan(119_000);
    expect(nextDelayMs(20, 60_000, () => 0.999)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(nextDelayMs(5, 60_000, () => 0)).toBe(1000); // never a hot loop
  });
});

describe('GpsPoller', () => {
  it('backoff grows on consecutive failures and resets after a success (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const delays = [];
      let fail = true;
      const provider = okProvider();
      provider.fetchLatest.mockImplementation(async () => { if (fail) throw new Error('provider down'); return [{ d: 'D1' }]; });
      const poller = new GpsPoller({
        db: fakeDb(), provider, lock: fakeLock(), logger: silent, intervalMs: 60_000, rng: () => 0.999,
        setTimeoutFn: (fn, ms) => { delays.push(ms); return setTimeout(fn, ms); }, clearTimeoutFn: clearTimeout,
      });
      await poller.start();
      for (let i = 0; i < 3; i++) await vi.advanceTimersToNextTimerAsync(); // eslint-disable-line no-await-in-loop -- 3 failing runs, in order
      fail = false;
      await vi.advanceTimersToNextTimerAsync(); // success
      await vi.advanceTimersToNextTimerAsync();
      // delays: [0 (first run), ~30s, ~60s, ~120s, 60s (reset), ...]
      expect(delays[0]).toBe(0);
      expect(delays[1]).toBeLessThan(30_000);
      expect(delays[2]).toBeGreaterThan(59_000);
      expect(delays[3]).toBeGreaterThan(119_000);
      expect(delays[4]).toBe(60_000);
      expect(poller.consecutiveFailures).toBe(0);
      await poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a throwing provider produces a FAILED run and the poller keeps going', async () => {
    const db = fakeDb();
    const provider = okProvider();
    provider.fetchLatest.mockRejectedValue(new Error('ECONNREFUSED provider'));
    const poller = new GpsPoller({ db, provider, lock: fakeLock(), logger: silent });
    const s = await poller.runOnce();
    expect(s.outcome).toBe('FAILED');
    expect(s.error).toMatch(/ECONNREFUSED/);
    expect(db.runs[0]).toMatchObject({ outcome: 'FAILED' });
    expect(poller.consecutiveFailures).toBe(1);
    provider.fetchLatest.mockResolvedValue([{ d: 'D1' }]);
    expect((await poller.runOnce()).outcome).toBe('SUCCESS');
    expect(poller.consecutiveFailures).toBe(0);
  });

  it('pollOnce reports provider timeouts as FAILED without throwing', async () => {
    const provider = okProvider();
    provider.fetchLatest.mockImplementation(({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason))));
    const s = await pollOnce({ db: fakeDb(), provider, deviceCache: createDeviceCache(), signal: AbortSignal.timeout(20) });
    expect(s.outcome).toBe('FAILED');
    expect(s.error).toMatch(/timeout|abort/i);
  });

  it('never runs two polls at once (runOnce returns the in-flight run)', async () => {
    let release;
    const provider = okProvider();
    provider.fetchLatest.mockImplementation(() => new Promise((r) => { release = () => r([]); }));
    const poller = new GpsPoller({ db: fakeDb(), provider, lock: fakeLock(), logger: silent });
    const a = poller.runOnce();
    const b = poller.runOnce();
    await vi.waitFor(() => expect(release).toBeDefined());
    release();
    expect(await a).toBe(await b);
    expect(provider.fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('graceful stop waits for the in-flight run, then releases the lock', async () => {
    let release;
    const provider = okProvider();
    provider.fetchLatest.mockImplementation(() => new Promise((r) => { release = () => r([]); }));
    const lock = fakeLock();
    const poller = new GpsPoller({ db: fakeDb(), provider, lock, logger: silent });
    const run = poller.runOnce();
    await vi.waitFor(() => expect(release).toBeDefined());
    let stopped = false;
    const stopping = poller.stop({ waitMs: 5000 }).then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false); // still waiting for the run
    expect(lock.release).not.toHaveBeenCalled();
    release();
    await run;
    await stopping;
    expect(stopped).toBe(true);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('standby: retries the lock every 60 s and becomes leader when it frees up', async () => {
    vi.useFakeTimers();
    try {
      let free = false;
      const lock = { tryAcquire: vi.fn(async () => free), held: () => free, release: vi.fn(async () => {}) };
      const provider = okProvider();
      const poller = new GpsPoller({ db: fakeDb(), provider, lock, logger: silent, lockRetryMs: 60_000 });
      await poller.start();
      expect(provider.fetchLatest).not.toHaveBeenCalled();
      free = true;
      await vi.advanceTimersByTimeAsync(60_000); // lock retry -> leader -> schedules run at 0
      await vi.advanceTimersToNextTimerAsync(); // fire the run
      for (let i = 0; i < 20 && !provider.fetchLatest.mock.calls.length; i++) await Promise.resolve(); // eslint-disable-line no-await-in-loop -- drain async chain
      expect(lock.tryAcquire).toHaveBeenCalledTimes(2);
      expect(provider.fetchLatest).toHaveBeenCalledTimes(1);
      await poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('deriveProviderState', () => {
  const now = Date.parse('2026-11-05T05:00:00Z');
  const run = (outcome, minsAgo, rec = 10, rej = 0) => ({
    outcome, started_at: new Date(now - minsAgo * 60_000), finished_at: new Date(now - minsAgo * 60_000), records_received: rec, records_rejected: rej,
  });
  const opts = { intervalMs: 60_000, now };
  it('UP / DEGRADED / DOWN rules', () => {
    expect(deriveProviderState([run('SUCCESS', 1)], opts).state).toBe('UP');
    expect(deriveProviderState([run('PARTIAL', 1, 10, 1)], opts).state).toBe('DEGRADED');
    expect(deriveProviderState([run('SUCCESS', 1, 10, 3)], opts).state).toBe('DEGRADED'); // >20 % rejected
    expect(deriveProviderState([run('FAILED', 1), run('FAILED', 2), run('FAILED', 3), run('SUCCESS', 4)], opts)).toMatchObject({ state: 'DOWN', consecutive_failures: 3 });
    expect(deriveProviderState([run('FAILED', 1), run('SUCCESS', 2)], opts)).toMatchObject({ state: 'UP', consecutive_failures: 1 });
    expect(deriveProviderState([run('SUCCESS', 6)], opts).state).toBe('DOWN'); // no success within 5 intervals
    expect(deriveProviderState([], opts)).toMatchObject({ state: 'DOWN', reason: 'No successful run yet', last_run: null });
    expect(deriveProviderState([{ outcome: 'RUNNING', started_at: new Date(now) }, run('SUCCESS', 1)], opts).state).toBe('UP'); // in-flight ignored
  });
});
