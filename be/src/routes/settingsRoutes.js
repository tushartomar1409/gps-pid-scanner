// GET /api/settings/public — non-sensitive settings any authenticated user may read (GUIDE #6 answer 2).
// STRICT WHITELIST: keys not listed here are never returned, whatever system_settings contains.
import { Router } from 'express';
import { db } from '../config/database.js';
import { sendSuccess } from '../utils/responseHandler.js';
import { DEFAULT_SERVICE_BBOX } from '../services/settingsService.js';

export const PUBLIC_SETTINGS = Object.freeze({
  'geo.service_area_bbox': DEFAULT_SERVICE_BBOX,
  'app.timezone': 'Asia/Kolkata',
  'detection.radius_m': 30,
  'gps.offline_after_seconds': 300,
});

export async function getPublicSettings(executor = db) {
  const keys = Object.keys(PUBLIC_SETTINGS);
  const { rows } = await executor.query(
    'SELECT setting_key, setting_value FROM system_settings WHERE setting_key = ANY($1::text[])', [keys]);
  const fromDb = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  // Defaults fill keys that are not (yet) in the DB; only whitelisted keys ever leave this function.
  return Object.fromEntries(keys.map((k) => [k, fromDb[k] ?? PUBLIC_SETTINGS[k]]));
}

export function createSettingsRoutes() {
  const router = Router();
  router.get('/public', async (_req, res) => {
    sendSuccess(res, { message: 'Public settings fetched successfully', data: await getPublicSettings() });
  });
  return router;
}
