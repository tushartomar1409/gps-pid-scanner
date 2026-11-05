// Map provider + defaults from env (flow.txt §3: provider must be configurable; no Google dependency).
const env = import.meta.env;

function parseCenter(v) {
  const [lat, lng] = String(v || '').split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : [28.4082, 77.3178];
}

function parseBbox(v) {
  const p = String(v || '').split(',').map(Number);
  return p.length === 4 && p.every(Number.isFinite)
    ? { min_lat: p[0], max_lat: p[1], min_lng: p[2], max_lng: p[3] }
    : { min_lat: 6, max_lat: 37.5, min_lng: 68, max_lng: 97.5 }; // India — mirrors be geo.service_area_bbox
}

export const MAP_CONFIG = Object.freeze({
  tileUrl: env.VITE_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: env.VITE_MAP_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  center: parseCenter(env.VITE_MAP_DEFAULT_CENTER),
  zoom: Number(env.VITE_MAP_DEFAULT_ZOOM) || 13,
  maxZoom: 19,
  // Client-side pre-check only; the server setting is authoritative and still returns `warning`.
  serviceAreaBbox: parseBbox(env.VITE_SERVICE_AREA_BBOX),
});
