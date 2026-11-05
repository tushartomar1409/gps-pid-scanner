// /api/pid-visits/* (visits:read), /api/detection/reprocess and /api/settings admin (SUPER_ADMIN).
import { Router } from 'express';
import { z } from 'zod';
import { requirePermission, requireRole } from '../middleware/roleMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { pagination, queryId } from '../validators/common.js';
import { listVisitEvents, dailySummary, missedPids, pidHistory } from '../services/pidVisitReadService.js';
import { reprocess } from '../services/coverageFinalizationService.js';
import { loadDetectionSettings, SETTING_DEFS } from '../services/settingsDefinitions.js';
import { clearSettingsCache } from '../services/settingsService.js';
import { recordActivity } from '../services/activityLogService.js';
import { requestContext } from '../controllers/crudController.js';
import { db, withTransaction } from '../config/database.js';
import { sendSuccess } from '../utils/responseHandler.js';
import { badRequest, notFound } from '../utils/errors.js';
import { formatZodIssues } from '../middleware/validationMiddleware.js';

const isoDate = z.iso.date('Use YYYY-MM-DD');
const bool = z.enum(['true', 'false']).transform((v) => v === 'true').optional();
const EVIDENCE = ['PROXIMITY_POINT', 'CONSECUTIVE_CONFIRMED', 'REJECTED_SPEED', 'REJECTED_STALE', 'TRACK_SEGMENT'];
const NON_CONFIRMED = ['GPS_VISIT_CANDIDATE', 'NOT_VISITED', 'GPS_DATA_UNAVAILABLE'];

const s = {
  visits: z.object({
    ...pagination, date: isoDate, pid_id: queryId, vehicle_id: queryId, route_assignment_id: queryId,
    evidence_status: z.enum(EVIDENCE).optional(), ambiguous: bool,
  }),
  summary: z.object({
    date: isoDate, group_by: z.enum(['zone', 'ward', 'agency', 'vehicle', 'route']).default('zone'),
    zone_id: queryId, ward_id: queryId, agency_id: queryId, vehicle_id: queryId,
  }),
  missed: z.object({
    ...pagination, date: isoDate, zone_id: queryId, ward_id: queryId, agency_id: queryId, vehicle_id: queryId, route_id: queryId,
    visit_status: z.enum(NON_CONFIRMED).optional(),
  }),
  history: z.object({ from: isoDate, to: isoDate }),
  pidParam: z.object({ pidId: z.coerce.number().int().positive() }),
  reprocess: z.union([
    z.strictObject({ route_assignment_id: z.number().int().positive() }),
    z.strictObject({ operational_date: isoDate, zone_id: z.number().int().positive().optional() }),
  ]),
};

export function createPidVisitRoutes() {
  const router = Router();
  const read = requirePermission('visits:read');
  router.get('/', read, validate({ query: s.visits }), async (req, res) => {
    const { rows, pagination: p } = await listVisitEvents(req.valid.query, req.scope);
    sendSuccess(res, { message: 'PID visit events fetched successfully', data: rows, pagination: p });
  });
  router.get('/daily-summary', read, validate({ query: s.summary }), async (req, res) => {
    sendSuccess(res, { message: 'Daily coverage summary', data: await dailySummary(req.valid.query, req.scope) });
  });
  router.get('/missed', read, validate({ query: s.missed }), async (req, res) => {
    const { rows, pagination: p } = await missedPids(req.valid.query, req.scope);
    sendSuccess(res, { message: 'Missed PIDs fetched successfully', data: rows, pagination: p });
  });
  router.get('/:pidId/history', read, validate({ params: s.pidParam, query: s.history }), async (req, res) => {
    sendSuccess(res, { message: 'PID visit history', data: await pidHistory(req.valid.params.pidId, req.valid.query, req.scope) });
  });
  return router;
}

export function createDetectionRoutes() {
  const router = Router();
  router.post('/reprocess', requireRole('SUPER_ADMIN'), validate({ body: s.reprocess }), async (req, res) => {
    const settings = await loadDetectionSettings(db);
    const data = await reprocess(req.valid.body, settings, requestContext(req), db);
    sendSuccess(res, { message: 'Reprocessing queued: derived data reset, points re-queued for detection', data });
  });
  return router;
}

const settingJsonSchema = (schema) => {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema, { unrepresentable: 'any' });
  return rest;
};

/** Admin settings: GET all, PUT one key (validated per key, audited old -> new). */
export function createSettingsAdminRoutes() {
  const router = Router();
  router.use(requireRole('SUPER_ADMIN'));
  router.get('/', async (_req, res) => {
    const { rows } = await db.query('SELECT setting_key, setting_value, description, updated_by, updated_at FROM system_settings ORDER BY setting_key');
    // `schema` (JSON Schema generated from the server's zod definition) lets the UI show and pre-check
    // valid ranges without a second, drifting copy of them; the server still validates every PUT.
    sendSuccess(res, {
      message: 'Settings fetched successfully',
      data: rows.map((r) => {
        const def = SETTING_DEFS[r.setting_key];
        return { ...r, editable: Boolean(def), default: def?.default ?? null, schema: def ? settingJsonSchema(def.schema) : null };
      }),
    });
  });
  router.put('/:key', validate({ params: z.object({ key: z.string().max(100) }), body: z.strictObject({ value: z.unknown() }) }), async (req, res) => {
    const { key } = req.valid.params;
    const def = SETTING_DEFS[key];
    if (!def) throw notFound(`Unknown or non-editable setting: ${key}`);
    const parsed = def.schema.safeParse(req.valid.body.value);
    if (!parsed.success) throw badRequest(`Invalid value for ${key}`, formatZodIssues(parsed.error).map((e) => ({ ...e, field: 'value' })));
    const ctx = requestContext(req);
    const row = await withTransaction(async (tx) => {
      const old = (await tx.query('SELECT setting_value FROM system_settings WHERE setting_key = $1 FOR UPDATE', [key])).rows[0];
      const { rows } = await tx.query(
        `INSERT INTO system_settings (setting_key, setting_value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING setting_key, setting_value, description, updated_by, updated_at`,
        [key, JSON.stringify(parsed.data), ctx.user.id]);
      await recordActivity(ctx, { action: 'UPDATE', module: 'settings', referenceId: key, details: { old: old?.setting_value ?? null, new: parsed.data } }, tx);
      return rows[0];
    });
    clearSettingsCache();
    sendSuccess(res, { message: `Setting ${key} updated (applies to new processing; use reprocess for the past)`, data: row });
  });
  return router;
}
