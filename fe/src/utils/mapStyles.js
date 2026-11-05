// One colour per coord_status everywhere (GUIDE #5). Visit-status colours (flow.txt §11) join in Phase 5.
export const COORD_STATUS_STYLES = {
  IMPORTED: { color: '#2563eb', label: 'Imported' },
  MANUALLY_CORRECTED: { color: '#0d9488', label: 'Manually corrected' },
  VERIFIED: { color: '#16a34a', label: 'Verified' },
  MISSING: { color: '#94a3b8', label: 'Missing (not on map)' },
};

export const COORD_STATUS_LEGEND = Object.entries(COORD_STATUS_STYLES).map(([key, s]) => ({ key, ...s }));

export const SELECTION_STYLE = { color: '#7c3aed', label: 'Selected for route' };
export const MUTED_STYLE = { color: '#94a3b8', label: 'Not on route' };
export const ROUTE_LINE_COLOR = '#7c3aed'; // flow §11: purple = assigned route

/** Pure geo helpers (unit-testable without Leaflet). */
export function inBbox(lat, lng, b) {
  return lat >= b.min_lat && lat <= b.max_lat && lng >= b.min_lng && lng <= b.max_lng;
}

export function serviceAreaWarning(lat, lng, b) {
  if (inBbox(lat, lng, b)) return null;
  if (lng >= -90 && lng <= 90 && inBbox(lng, lat, b)) return 'Latitude/longitude look swapped (swapping them falls inside the service area).';
  return 'This point is outside the configured service area.';
}

/** Leaflet LatLngBounds -> API bbox string minLng,minLat,maxLng,maxLat (clamped). */
export function boundsToBbox(bounds) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  return [clamp(sw.lng, -180, 180), clamp(sw.lat, -90, 90), clamp(ne.lng, -180, 180), clamp(ne.lat, -90, 90)]
    .map((v) => v.toFixed(6))
    .join(',');
}
