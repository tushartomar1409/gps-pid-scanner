// Provider-independent validation of NormalizedPoints (GUIDE #6 B). Rejections are reason codes that
// get counted per poll run — never thrown. Late / out-of-order points are VALID here (flow.txt §22.14-15);
// the detection age check belongs to Phase 4.

/**
 * NormalizedPoint (flow.txt §7):
 * @typedef {object} NormalizedPoint
 * @property {string}  device_id
 * @property {string}  [vehicle_number]
 * @property {number}  latitude
 * @property {number}  longitude
 * @property {number|null} speed            km/h
 * @property {boolean|null} ignition
 * @property {number|null} [heading]        0-360
 * @property {number|null} [gps_accuracy]   metres / HDOP
 * @property {Date}    recorded_at          device fix time
 * @property {string|null} provider_status
 * @property {object}  raw                  original provider record
 */

export const REJECT = Object.freeze({
  INVALID_COORDS: 'INVALID_COORDS',
  NO_TIMESTAMP: 'NO_TIMESTAMP',
  BAD_TIMESTAMP: 'BAD_TIMESTAMP',
  FUTURE_TIMESTAMP: 'FUTURE_TIMESTAMP',
  UNKNOWN_DEVICE: 'UNKNOWN_DEVICE',
  NEGATIVE_SPEED: 'NEGATIVE_SPEED',
  NORMALIZE_FAILED: 'NORMALIZE_FAILED', // adapter could not map the raw record at all
});

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {NormalizedPoint} p
 * @param {{ now: Date, futureToleranceS: number, deviceMap: Map<string, {id:number}> }} ctx
 * @returns {{ ok: NormalizedPoint & { vehicle_id: number } } | { error: string }}
 */
export function validatePoint(p, { now, futureToleranceS, deviceMap }) {
  if (!finite(p.latitude) || !finite(p.longitude) || p.latitude < -90 || p.latitude > 90
      || p.longitude < -180 || p.longitude > 180 || (p.latitude === 0 && p.longitude === 0)) {
    return { error: REJECT.INVALID_COORDS };
  }
  if (!(p.recorded_at instanceof Date)) return { error: REJECT.NO_TIMESTAMP };
  if (Number.isNaN(p.recorded_at.getTime())) return { error: REJECT.BAD_TIMESTAMP };
  if (p.recorded_at.getTime() - now.getTime() > futureToleranceS * 1000) return { error: REJECT.FUTURE_TIMESTAMP };
  if (p.speed !== null && p.speed !== undefined && (!finite(p.speed) || p.speed < 0)) return { error: REJECT.NEGATIVE_SPEED };
  const vehicle = deviceMap.get(String(p.device_id));
  if (!vehicle) return { error: REJECT.UNKNOWN_DEVICE };
  return { ok: { ...p, vehicle_id: vehicle.id } };
}

/** Adapter.normalize + validatePoint over a batch; returns valid points and per-reason counts. */
export function normalizeBatch(rawRecords, provider, ctx) {
  const valid = [];
  const rejected = {};
  const bump = (code) => { rejected[code] = (rejected[code] || 0) + 1; };
  for (const raw of rawRecords) {
    let n;
    try {
      n = provider.normalize(raw);
    } catch {
      n = { error: REJECT.NORMALIZE_FAILED };
    }
    if (n.error) { bump(n.error); continue; }
    const v = validatePoint(n.ok, ctx);
    if (v.error) bump(v.error);
    else valid.push(v.ok);
  }
  return { valid, rejected };
}
