// Reads system_settings with a short in-process cache (settings change rarely; admin UI comes later).
import { db as defaultDb } from '../config/database.js';

const TTL_MS = 30_000;
const cache = new Map(); // key -> { value, at }

export async function getSetting(key, fallback = null, executor = defaultDb) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const { rows } = await executor.query('SELECT setting_value FROM system_settings WHERE setting_key = $1', [key]);
  const value = rows.length ? rows[0].setting_value : fallback;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export function clearSettingsCache() {
  cache.clear();
}

export const DEFAULT_SERVICE_BBOX = Object.freeze({ min_lat: 6, max_lat: 37.5, min_lng: 68, max_lng: 97.5 });

export async function getServiceAreaBbox(executor) {
  const v = await getSetting('geo.service_area_bbox', DEFAULT_SERVICE_BBOX, executor);
  return v && typeof v === 'object' ? v : DEFAULT_SERVICE_BBOX;
}
