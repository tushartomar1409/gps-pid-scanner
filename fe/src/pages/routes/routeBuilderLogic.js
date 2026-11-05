// Pure route-builder logic (no Leaflet) so it is unit-testable.
import { parseApiError } from '../../utils/apiErrors.js';

export const MAX_ASSIGN = 5000;

export function toggleId(selected, id) {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Adds every point for which contains(lat, lng) is true. */
export function addPointsWhere(selected, points, contains) {
  const next = new Set(selected);
  for (const p of points) if (contains(p.latitude, p.longitude)) next.add(p.id);
  return next;
}

/** Which assign-pids call (if any) makes the saved route PID list equal to `selectedIds`. */
export function planAssignCall(selectedIds, savedIds) {
  if (selectedIds.length > 0) return { mode: 'replace', pid_ids: selectedIds };
  if (savedIds.length > 0) return { mode: 'remove', pid_ids: savedIds }; // replace needs >= 1 id
  return null;
}

/**
 * Two-call save: (1) create/update the route, (2) assign-pids. If (2) fails the route IS saved;
 * the caller keeps the selection so the user can retry.
 * Returns { routeId, route, pidsResult, failedStep: null | 'route' | 'pids', error }.
 */
export async function saveRouteAndPids({ api, routeId, payload, selectedIds, savedIds }) {
  if (selectedIds.length > MAX_ASSIGN) {
    return { routeId, failedStep: 'route', error: { message: `A route can be saved with at most ${MAX_ASSIGN} PIDs per save (selected ${selectedIds.length}).`, fieldErrors: {} } };
  }
  let route;
  try {
    route = routeId ? (await api.update(routeId, payload)).data : (await api.create(payload)).data;
  } catch (err) {
    return { routeId, failedStep: 'route', error: parseApiError(err) };
  }
  const plan = planAssignCall(selectedIds, savedIds);
  if (!plan) return { routeId: route.id, route, pidsResult: null, failedStep: null };
  try {
    const { data } = await api.assignPids(route.id, plan);
    return { routeId: route.id, route, pidsResult: data, failedStep: null };
  } catch (err) {
    return { routeId: route.id, route, failedStep: 'pids', error: parseApiError(err) };
  }
}

/** Route form -> API payload (start/end as pairs, geometry as GeoJSON [lng, lat]). */
export function buildRoutePayload(form, { start, end, line, isEdit }) {
  const n = (v) => (v === '' || v == null ? null : Number(v));
  return {
    route_code: form.route_code.trim().toUpperCase(),
    route_name: form.route_name.trim(),
    ward_id: Number(form.ward_id),
    ...(form.zone_id ? { zone_id: Number(form.zone_id) } : {}),
    agency_id: n(form.agency_id),
    default_vehicle_id: n(form.default_vehicle_id),
    start_latitude: start ? start[0] : null,
    start_longitude: start ? start[1] : null,
    end_latitude: end ? end[0] : null,
    end_longitude: end ? end[1] : null,
    route_geometry: line.length >= 2 ? { type: 'LineString', coordinates: line.map(([lat, lng]) => [lng, lat]) } : null,
    ...(isEdit ? { status: form.status } : {}),
  };
}

export function validateRouteForm(form) {
  const errors = {};
  if (!form.route_code.trim()) errors.route_code = 'Route code is required';
  else if (!/^[A-Za-z0-9_-]{1,30}$/.test(form.route_code.trim())) errors.route_code = 'Up to 30 letters, digits, _ or -';
  if (!form.route_name.trim()) errors.route_name = 'Route name is required';
  if (!form.ward_id) errors.ward_id = 'Ward is required';
  return errors;
}
