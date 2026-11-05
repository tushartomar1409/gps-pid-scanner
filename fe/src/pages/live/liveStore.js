// Live vehicle store (GUIDE #9 C1): REST snapshot + socket deltas merged into a Map keyed by vehicle_id.
// Pure functions; the hook in useLiveVehicles.js owns timers/subscriptions.

const ms = (t) => (t ? new Date(t).getTime() : NaN);

/** Snapshot rows from /gps/live-vehicles?view=map -> Map<vehicle_id, row>. */
export function fromSnapshot(rows = []) {
  return new Map(rows.map((r) => [r.vehicle_id, { ...r }]));
}

/**
 * Merges `vehicle:locations` deltas ([{vehicle_id, lat, lng, speed, heading, ignition, recorded_at, connection_status}]).
 * - unknown vehicle ids are ignored (outside the page's filters/snapshot)
 * - a delta OLDER than (or equal to) the stored recorded_at is ignored
 * Returns { map, changed, newest } — the same Map instance when nothing changed (cheap React bail-out).
 */
export function mergeDeltas(map, deltas = []) {
  let next = null;
  let newest = null;
  for (const d of deltas) {
    const cur = (next || map).get(d.vehicle_id);
    if (!cur) continue;
    const t = ms(d.recorded_at);
    if (!Number.isFinite(t)) continue;
    const curT = ms(cur.recorded_at);
    if (Number.isFinite(curT) && t <= curT) continue;
    if (!next) next = new Map(map);
    next.set(d.vehicle_id, {
      ...cur,
      latitude: d.lat,
      longitude: d.lng,
      speed: d.speed ?? cur.speed,
      heading: d.heading ?? cur.heading,
      ignition: d.ignition ?? cur.ignition,
      recorded_at: d.recorded_at,
      connection_status: cur.connection_status === 'INACTIVE' ? 'INACTIVE' : d.connection_status || 'ONLINE',
    });
    if (newest === null || t > newest) newest = t;
  }
  return { map: next || map, changed: Boolean(next), newest };
}

/** Client-side ageing: INACTIVE stays; no position -> NO_DATA; older than offlineAfterS -> OFFLINE. */
export function ageStatus(v, nowMs, offlineAfterS) {
  if (v.connection_status === 'INACTIVE') return 'INACTIVE';
  const t = ms(v.recorded_at);
  if (!Number.isFinite(t) || v.latitude == null) return 'NO_DATA';
  return nowMs - t > offlineAfterS * 1000 ? 'OFFLINE' : 'ONLINE';
}

export function applyAgeing(map, nowMs, offlineAfterS) {
  let next = null;
  for (const [id, v] of map) {
    const s = ageStatus(v, nowMs, offlineAfterS);
    if (s !== v.connection_status) {
      if (!next) next = new Map(map);
      next.set(id, { ...v, connection_status: s });
    }
  }
  return next || map;
}

export function countByStatus(vehicles) {
  const out = { ONLINE: 0, OFFLINE: 0, NO_DATA: 0, INACTIVE: 0 };
  for (const v of vehicles) out[v.connection_status] = (out[v.connection_status] || 0) + 1;
  return out;
}

/** "12 s ago" / "5 min ago" / "3 h ago". */
export function agoLabel(at, nowMs) {
  const t = ms(at);
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** Case-insensitive vehicle-number search (exact first, then prefix, then contains). */
export function findVehicle(vehicles, query) {
  const q = String(query || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return null;
  const norm = (v) => String(v.vehicle_number || '').toLowerCase().replace(/\s+/g, '');
  return vehicles.find((v) => norm(v) === q) || vehicles.find((v) => norm(v).startsWith(q)) || vehicles.find((v) => norm(v).includes(q)) || null;
}
