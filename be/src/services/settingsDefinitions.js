// Editable settings: one zod schema + default per key (GUIDE #7 G). Unknown keys cannot be written.
import { z } from 'zod';

const nullableNum = (min, max) => z.number().min(min).max(max).nullable();

export const SETTING_DEFS = {
  'detection.enabled': { schema: z.boolean(), default: true },
  'detection.radius_m': { schema: z.number().min(5).max(200), default: 30 },
  'detection.max_gps_age_s': { schema: z.number().int().min(30).max(86_400), default: 300 },
  'detection.min_speed_kmh': { schema: nullableNum(0, 200), default: null },
  'detection.max_speed_kmh': { schema: nullableNum(1, 300), default: null },
  'detection.consecutive_points': { schema: z.number().int().min(1).max(10), default: 2 },
  'detection.duplicate_prevention': { schema: z.boolean(), default: true },
  'detection.confirmation_mode': { schema: z.enum(['consecutive_points', 'min_events', 'dwell']), default: 'consecutive_points' },
  'detection.confirmation_window_s': { schema: z.number().int().min(10).max(3600), default: 300 },
  'detection.min_dwell_seconds': { schema: z.number().int().min(5).max(3600), default: 60 },
  'detection.late_points_policy': { schema: z.enum(['evidence_only', 'accept']), default: 'evidence_only' },
  'detection.finalize_grace_minutes': { schema: z.number().int().min(0).max(1440), default: 120 },
  'detection.segment_evidence_enabled': { schema: z.boolean(), default: true },
  'detection.segment_max_length_m': { schema: z.number().min(20).max(1000), default: 200 },
  'detection.segment_max_gap_s': { schema: z.number().int().min(5).max(600), default: 90 },
  'detection.deviation_threshold_m': { schema: z.number().min(5).max(1000), default: 50 },
  'detection.distance_min_segment_m': { schema: z.number().min(0).max(100), default: 5 },
  'gps.offline_after_seconds': { schema: z.number().int().min(30).max(86_400), default: 300 },
  'gps.poll_interval_seconds': { schema: z.number().int().min(5).max(3600), default: 60 },
  'gps.min_points_for_data_available': { schema: z.number().int().min(0).max(1000), default: 5 },
  // Raw GPS retention (GUIDE #11 A): ≥ 35 days so the current + previous month are never dropped.
  'gps.retention_days': { schema: z.number().int().min(35).max(3650), default: 180 },
  'geo.service_area_bbox': {
    schema: z.strictObject({ min_lat: z.number().min(-90).max(90), max_lat: z.number().min(-90).max(90), min_lng: z.number().min(-180).max(180), max_lng: z.number().min(-180).max(180) })
      .refine((b) => b.min_lat < b.max_lat && b.min_lng < b.max_lng, 'min must be < max'),
    default: { min_lat: 6, max_lat: 37.5, min_lng: 68, max_lng: 97.5 },
  },
  'app.timezone': {
    schema: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown IANA timezone'),
    default: 'Asia/Kolkata',
  },
};

/** Everything the detection engine needs, read in ONE query per run (defaults fill gaps). */
export async function loadDetectionSettings(db, overrides = {}) {
  const keys = Object.keys(SETTING_DEFS).filter((k) => k.startsWith('detection.') || k === 'app.timezone');
  const { rows } = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key = ANY($1::text[])', [keys]);
  const v = Object.fromEntries(keys.map((k) => [k, SETTING_DEFS[k].default]));
  for (const r of rows) v[r.setting_key] = r.setting_value;
  const s = {
    enabled: v['detection.enabled'] !== false,
    radiusM: Number(v['detection.radius_m']),
    maxGpsAgeS: Number(v['detection.max_gps_age_s']),
    minSpeedKmh: v['detection.min_speed_kmh'] === null ? null : Number(v['detection.min_speed_kmh']),
    maxSpeedKmh: v['detection.max_speed_kmh'] === null ? null : Number(v['detection.max_speed_kmh']),
    consecutivePoints: Number(v['detection.consecutive_points']),
    confirmationMode: v['detection.confirmation_mode'],
    confirmationWindowS: Number(v['detection.confirmation_window_s']),
    minDwellSeconds: Number(v['detection.min_dwell_seconds']),
    latePointsPolicy: v['detection.late_points_policy'],
    finalizeGraceMinutes: Number(v['detection.finalize_grace_minutes']),
    segmentEvidenceEnabled: v['detection.segment_evidence_enabled'] !== false,
    segmentMaxLengthM: Number(v['detection.segment_max_length_m']),
    segmentMaxGapS: Number(v['detection.segment_max_gap_s']),
    deviationThresholdM: Number(v['detection.deviation_threshold_m']),
    distanceMinSegmentM: Number(v['detection.distance_min_segment_m']),
    timezone: v['app.timezone'],
  };
  return { ...s, ...overrides };
}
