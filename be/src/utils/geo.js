// Coordinate helpers shared by PID CRUD, import and route validation.

export const isLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
export const isLng = (v) => Number.isFinite(v) && v >= -180 && v <= 180;

/** Round to the DB precision NUMERIC(10,7) so in-memory comparisons match stored values. */
export const round7 = (v) => Math.round(v * 1e7) / 1e7;

export function inBbox(lat, lng, bbox) {
  return lat >= bbox.min_lat && lat <= bbox.max_lat && lng >= bbox.min_lng && lng <= bbox.max_lng;
}

/**
 * Service-area warning for a coordinate pair (never an error).
 * Returns null when inside; a "looks swapped" message when swapping lat/lng would put it inside.
 */
export function bboxWarning(lat, lng, bbox) {
  if (inBbox(lat, lng, bbox)) return null;
  if (isLat(lng) && inBbox(lng, lat, bbox)) {
    return { code: 'SWAPPED', message: 'Latitude/longitude look swapped (swapping them falls inside the service area)' };
  }
  return { code: 'OUTSIDE_SERVICE_AREA', message: 'Coordinates are outside the configured service area' };
}
