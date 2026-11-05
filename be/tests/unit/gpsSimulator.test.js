import { describe, it, expect } from 'vitest';
import { createSimulatorProvider, buildVehicles, simConfigFromEnv } from '../../src/services/gps/providers/simulatorProvider.js';
import { createProvider } from '../../src/services/gps/providers/index.js';
import { haversineM } from '../../src/services/gps/geoMath.js';
import { parseProviderTimestamp } from '../../src/services/gps/timestamps.js';

const base = { ...simConfigFromEnv(), seed: 7, speedKmh: 15, jitterM: 0, dropoutPct: 0, duplicatePct: 0, outOfOrderPct: 0, latePct: 0, badPct: 0, offlineVehicles: [], tz: 'Asia/Kolkata' };
const NOW = new Date('2026-11-05T05:00:00.000Z');

const planRows = (n, geometry = null) => Array.from({ length: n }, (_, i) => ({
  vehicle_id: i + 1, vehicle_number: `V${i + 1}`, device_id: `D${i + 1}`, route_geometry: geometry,
  pids: [[100 + i, 28.40 + i * 0.001, 77.30], [200 + i, 28.401 + i * 0.001, 77.301], [300 + i, 28.402 + i * 0.001, 77.300]],
}));
const sim = (cfg = {}) => {
  const p = createSimulatorProvider({ db: null, config: { ...base, ...cfg }, nodeEnv: 'test', now: () => NOW });
  p.setVehicles(buildVehicles(planRows(1000), base.seed));
  return p;
};

describe('simulator provider', () => {
  it('refuses to load in production (directly and via the registry)', () => {
    expect(() => createSimulatorProvider({ db: null, nodeEnv: 'production' })).toThrow(/refuses to load when NODE_ENV=production/);
    expect(() => createProvider('simulator', { db: null, nodeEnv: 'production' })).toThrow(/production/);
  });

  it('is deterministic: same seed + same tick -> identical records; another seed differs', () => {
    const a = sim().generate(NOW, 3);
    const b = sim().generate(NOW, 3);
    expect(a).toEqual(b);
    const otherSeed = createSimulatorProvider({ db: null, config: { ...base, seed: 8 }, nodeEnv: 'test' });
    otherSeed.setVehicles(buildVehicles(planRows(1000), 8));
    expect(otherSeed.generate(NOW, 3)).not.toEqual(a);
  });

  it('places snapshot-PID waypoints 5–15 m from each PID', () => {
    const [v] = buildVehicles(planRows(1), 7);
    const pids = planRows(1)[0].pids.map(([, la, ln]) => [la, ln]);
    v.loop.pts.slice(0, 3).forEach((p, i) => {
      const d = haversineM(p, pids[i]);
      expect(d).toBeGreaterThanOrEqual(4.9);
      expect(d).toBeLessThanOrEqual(15.1);
    });
  });

  it('follows the route geometry when present', () => {
    const geometry = { type: 'LineString', coordinates: [[77.30, 28.40], [77.31, 28.40]] };
    const p = createSimulatorProvider({ db: null, config: base, nodeEnv: 'test' });
    p.setVehicles(buildVehicles(planRows(1, geometry), 7));
    const [rec] = p.generate(NOW, 0);
    expect(rec.lat).toBeCloseTo(28.40, 3); // on the east-west segment (jitter 0)
    expect(rec.lon).toBeGreaterThanOrEqual(77.30);
    expect(rec.lon).toBeLessThanOrEqual(77.31);
  });

  it('emits naive local timestamps that normalize back to the true instant', () => {
    const [rec] = sim().generate(NOW, 0);
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const n = sim().normalize(rec);
    expect(NOW.getTime() - n.ok.recorded_at.getTime()).toBeGreaterThanOrEqual(0);
    expect(NOW.getTime() - n.ok.recorded_at.getTime()).toBeLessThanOrEqual(21_000); // 0–20 s lag (+ second truncation)
    expect(n.ok).toMatchObject({ device_id: 'D1', vehicle_number: 'V1', ignition: true, provider_status: 'online' });
  });

  it('honours dropout / duplicate / out-of-order / late / bad percentages over 1,000 vehicle-ticks (±4 pts)', () => {
    const p = sim({ dropoutPct: 10, duplicatePct: 10, outOfOrderPct: 10, latePct: 10, badPct: 10 });
    const recs = p.generate(NOW, 1);
    const byDevice = new Map();
    for (const r of recs) byDevice.set(r.imei, [...(byDevice.get(r.imei) || []), r]);
    const reported = byDevice.size;
    const dropout = 1000 - reported;
    let dup = 0; let ooo = 0; let late = 0; let bad = 0;
    for (const list of byDevice.values()) {
      const main = list[0];
      const mainAt = parseProviderTimestamp(main.ts, 'Asia/Kolkata').ok.getTime();
      if ((main.lat === 0 && main.lon === 0) || main.lat > 90) bad++;
      if (list.slice(1).some((r) => r.ts === main.ts && r.lat === main.lat)) dup++;
      for (const r of list.slice(1)) {
        const age = mainAt - parseProviderTimestamp(r.ts, 'Asia/Kolkata').ok.getTime();
        if (age >= 59_000 && age <= 121_000) ooo++;
        if (age >= 299_000) late++;
      }
    }
    expect(Math.abs(dropout - 100)).toBeLessThanOrEqual(40);
    for (const [label, n] of [['dup', dup], ['ooo', ooo], ['late', late], ['bad', bad]]) {
      expect(Math.abs(n / reported - 0.1), label).toBeLessThanOrEqual(0.04);
    }
  });

  it('never emits for configured offline vehicles', () => {
    const recs = sim({ offlineVehicles: ['V1', 'V2'] }).generate(NOW, 0);
    expect(recs.some((r) => ['D1', 'D2'].includes(r.imei))).toBe(false);
    expect(recs).toHaveLength(998);
  });
});
