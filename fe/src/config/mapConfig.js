// Map provider + defaults from env (flow.txt §3: provider must be configurable; no Google dependency).
const env = import.meta.env;

function parseCenter(v) {
  const [lat, lng] = String(v || '').split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : [28.4082, 77.3178];
}

export const MAP_CONFIG = Object.freeze({
  tileUrl: env.VITE_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: env.VITE_MAP_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  center: parseCenter(env.VITE_MAP_DEFAULT_CENTER),
  zoom: Number(env.VITE_MAP_DEFAULT_ZOOM) || 13,
  maxZoom: 19,
  // Service-area bbox now comes from GET /api/settings/public (useSettings), not from env.
});
