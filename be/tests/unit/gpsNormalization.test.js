import { describe, it, expect } from 'vitest';
import { parseProviderTimestamp } from '../../src/services/gps/timestamps.js';
import { validatePoint, normalizeBatch, REJECT } from '../../src/services/gps/gpsNormalizationService.js';

const NOW = new Date('2026-11-05T05:00:00.000Z'); // 10:30 IST
const deviceMap = new Map([['DEV1', { id: 11 }]]);
const ctx = { now: NOW, futureToleranceS: 120, deviceMap };
const good = (o = {}) => ({
  device_id: 'DEV1', latitude: 28.4, longitude: 77.3, speed: 20, ignition: true, recorded_at: new Date(NOW.getTime() - 30_000),
  provider_status: 'online', raw: {}, ...o,
});

describe('parseProviderTimestamp', () => {
  it('interprets naive timestamps in the provider timezone (IST, no DST)', () => {
    expect(parseProviderTimestamp('2026-11-05 10:30:00', 'Asia/Kolkata').ok.toISOString()).toBe('2026-11-05T05:00:00.000Z');
    expect(parseProviderTimestamp('2026-11-05T10:30', 'Asia/Kolkata').ok.toISOString()).toBe('2026-11-05T05:00:00.000Z');
    // IST has no DST: a June wall-clock time maps with the same +05:30 offset.
    expect(parseProviderTimestamp('2026-06-15 00:15:00', 'Asia/Kolkata').ok.toISOString()).toBe('2026-06-14T18:45:00.000Z');
    // Same naive value in UTC provider zone
    expect(parseProviderTimestamp('2026-11-05 10:30:00', 'UTC').ok.toISOString()).toBe('2026-11-05T10:30:00.000Z');
  });

  it('respects explicit Z / offsets regardless of provider timezone', () => {
    expect(parseProviderTimestamp('2026-11-05T05:00:00Z', 'Asia/Kolkata').ok.toISOString()).toBe('2026-11-05T05:00:00.000Z');
    expect(parseProviderTimestamp('2026-11-05T10:30:00+05:30', 'UTC').ok.toISOString()).toBe('2026-11-05T05:00:00.000Z');
    expect(parseProviderTimestamp('2026-11-05 10:30:00+0530', 'UTC').ok.toISOString()).toBe('2026-11-05T05:00:00.000Z');
  });

  it('accepts epoch seconds and milliseconds', () => {
    expect(parseProviderTimestamp(1793854800, 'UTC').ok.toISOString()).toBe('2026-11-05T05:00:00.000Z');
    expect(parseProviderTimestamp(1793854800000, 'UTC').ok.toISOString()).toBe('2026-11-05T05:00:00.000Z');
    expect(parseProviderTimestamp('1793854800', 'UTC').ok.toISOString()).toBe('2026-11-05T05:00:00.000Z');
  });

  it('returns NO_TIMESTAMP / BAD_TIMESTAMP', () => {
    expect(parseProviderTimestamp(undefined, 'UTC')).toEqual({ error: 'NO_TIMESTAMP' });
    expect(parseProviderTimestamp('', 'UTC')).toEqual({ error: 'NO_TIMESTAMP' });
    expect(parseProviderTimestamp('yesterday', 'UTC')).toEqual({ error: 'BAD_TIMESTAMP' });
    expect(parseProviderTimestamp('2026-13-45 99:99:99', 'UTC')).toEqual({ error: 'BAD_TIMESTAMP' });
    expect(parseProviderTimestamp({}, 'UTC')).toEqual({ error: 'BAD_TIMESTAMP' });
  });
});

describe('validatePoint', () => {
  it('accepts a valid point and resolves the vehicle', () => {
    expect(validatePoint(good(), ctx).ok.vehicle_id).toBe(11);
  });

  it.each([
    ['latitude out of range', { latitude: 91 }, REJECT.INVALID_COORDS],
    ['longitude out of range', { longitude: -181 }, REJECT.INVALID_COORDS],
    ['NaN coords', { latitude: Number.NaN }, REJECT.INVALID_COORDS],
    ['null island 0,0', { latitude: 0, longitude: 0 }, REJECT.INVALID_COORDS],
    ['no timestamp', { recorded_at: null }, REJECT.NO_TIMESTAMP],
    ['bad timestamp', { recorded_at: new Date('x') }, REJECT.BAD_TIMESTAMP],
    ['negative speed', { speed: -1 }, REJECT.NEGATIVE_SPEED],
    ['unknown device', { device_id: 'NOPE' }, REJECT.UNKNOWN_DEVICE],
  ])('%s -> %s', (_label, patch, code) => {
    expect(validatePoint(good(patch), ctx)).toEqual({ error: code });
  });

  it('future tolerance boundary: +120 s accepted, +121 s rejected', () => {
    expect(validatePoint(good({ recorded_at: new Date(NOW.getTime() + 120_000) }), ctx).ok).toBeDefined();
    expect(validatePoint(good({ recorded_at: new Date(NOW.getTime() + 121_000) }), ctx)).toEqual({ error: REJECT.FUTURE_TIMESTAMP });
  });

  it('keeps late / out-of-order points (age is checked by detection, not ingestion)', () => {
    expect(validatePoint(good({ recorded_at: new Date(NOW.getTime() - 3 * 3600_000) }), ctx).ok).toBeDefined();
  });

  it('allows a null speed; only 0,0 exactly counts as null island', () => {
    expect(validatePoint(good({ speed: null }), ctx).ok).toBeDefined();
    expect(validatePoint(good({ latitude: 0, longitude: 77.3 }), ctx).ok).toBeDefined();
  });
});

describe('normalizeBatch', () => {
  it('counts adapter and validation rejects by reason, never throws', () => {
    const provider = {
      normalize(raw) {
        if (raw.boom) throw new Error('mapping bug');
        if (!raw.ts) return { error: 'NO_TIMESTAMP' };
        return { ok: good({ latitude: raw.lat }) };
      },
    };
    const { valid, rejected } = normalizeBatch(
      [{ ts: 1, lat: 28.4 }, { ts: 1, lat: 0 }, {}, { boom: true }, { ts: 1, lat: 999 }], provider, { ...ctx },
    );
    expect(valid).toHaveLength(2); // lat 0 with lng 77.3 is valid
    expect(rejected).toEqual({ NO_TIMESTAMP: 1, NORMALIZE_FAILED: 1, INVALID_COORDS: 1 });
  });
});
