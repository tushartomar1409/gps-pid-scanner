// Coverage map pure logic (GUIDE #9 D): layer toggles, live recolour, trail append.

export const DEFAULT_TOGGLES = Object.freeze({ assignedRoute: true, actualRoute: true, allPids: true, visited: true, unvisited: true });

const VISITED = new Set(['GPS_VISIT_CONFIRMED', 'GPS_VISIT_CANDIDATE']);
const UNVISITED = new Set(['NOT_VISITED', 'GPS_DATA_UNAVAILABLE']);

/**
 * PID visibility (flow §11 toggles). "All PIDs" on -> every PID. Off -> the union of the
 * "Visited" (confirmed + candidate) and "Unvisited" (not visited + unavailable) toggles.
 */
export function pidVisible(pid, toggles) {
  if (toggles.allPids) return true;
  const s = pid.visit_status || 'NOT_VISITED';
  return (toggles.visited && VISITED.has(s)) || (toggles.unvisited && UNVISITED.has(s));
}

/** PIDs that can be drawn (have snapshot coordinates) and pass the toggles. */
export function visiblePids(pids, toggles) {
  return pids.filter((p) => p.latitude != null && p.longitude != null && pidVisible(p, toggles));
}

/** Toggling "All PIDs" off narrows to the other two; turning visited+unvisited both on means all. */
export function toggle(toggles, key) {
  const next = { ...toggles, [key]: !toggles[key] };
  if (key === 'allPids' && next.allPids) Object.assign(next, { visited: true, unvisited: true });
  if ((key === 'visited' || key === 'unvisited') && !next[key]) next.allPids = false;
  if ((key === 'visited' || key === 'unvisited') && next.visited && next.unvisited) next.allPids = true;
  return next;
}

/** Recolour PIDs in place from a pid:status payload (only changes for this assignment). Returns same array if unchanged. */
export function applyPidStatusChanges(pids, changes = [], assignmentId) {
  const mine = new Map(changes.filter((c) => c.route_assignment_id === assignmentId).map((c) => [c.pid_id, c.new_status]));
  if (!mine.size) return pids;
  let changed = false;
  const out = pids.map((p) => {
    const s = mine.get(p.pid_id);
    if (!s || s === p.visit_status) return p;
    changed = true;
    return { ...p, visit_status: s };
  });
  return changed ? out : pids;
}

/** Server-sent counts for this assignment (never recomputed on the client). */
export function countsFromPayload(payload, assignmentId) {
  const a = payload?.assignments?.find((x) => x.route_assignment_id === assignmentId);
  if (!a) return null;
  const pct = (n) => (a.assigned ? Math.round((1000 * n) / a.assigned) / 10 : null);
  return {
    assigned: a.assigned, confirmed: a.confirmed, candidate: a.candidate, remaining: a.assigned - a.confirmed,
    confirmed_pct: pct(a.confirmed), detected_pct: pct(a.confirmed + a.candidate),
  };
}

/** Append a vehicle:locations delta to the trail if it is this vehicle and newer than the last point. */
export function appendToTrail(trail, deltas = [], vehicleId) {
  const lastT = trail.length ? new Date(trail[trail.length - 1].recorded_at).getTime() : -Infinity;
  const add = deltas
    .filter((d) => d.vehicle_id === vehicleId && new Date(d.recorded_at).getTime() > lastT)
    .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at))
    .map((d) => ({ latitude: d.lat, longitude: d.lng, speed: d.speed, recorded_at: d.recorded_at }));
  return add.length ? [...trail, ...add] : trail;
}

/** GeoJSON LineString/MultiLineString -> array of [lat,lng][] polylines. */
export function geometryToLatLngs(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates.map(([lng, lat]) => [lat, lng])];
  if (geom.type === 'MultiLineString') return geom.coordinates.map((l) => l.map(([lng, lat]) => [lat, lng]));
  return [];
}

/** Off-route segment {from,to} -> the trail points inside that time range. */
export function segmentLatLngs(track, seg) {
  const f = new Date(seg.from).getTime();
  const t = new Date(seg.to).getTime();
  return track.filter((p) => {
    const x = new Date(p.recorded_at).getTime();
    return x >= f && x <= t;
  }).map((p) => [p.latitude, p.longitude]);
}
