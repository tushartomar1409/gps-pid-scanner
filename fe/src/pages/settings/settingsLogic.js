// Detection settings: grouping + client-side pre-validation from the server's JSON Schema (GUIDE #9 F1).
// The server re-validates every PUT; this only gives immediate feedback.

export const GROUPS = [
  { id: 'proximity', title: 'Proximity', keys: ['detection.enabled', 'detection.radius_m', 'detection.duplicate_prevention'] },
  {
    id: 'confirmation', title: 'Confirmation',
    keys: ['detection.confirmation_mode', 'detection.consecutive_points', 'detection.confirmation_window_s', 'detection.min_dwell_seconds'],
  },
  {
    id: 'quality', title: 'Quality gates',
    keys: ['detection.max_gps_age_s', 'detection.min_speed_kmh', 'detection.max_speed_kmh', 'detection.late_points_policy'],
  },
  { id: 'segments', title: 'Segment evidence', keys: ['detection.segment_evidence_enabled', 'detection.segment_max_length_m', 'detection.segment_max_gap_s'] },
  { id: 'finalization', title: 'Finalization', keys: ['detection.finalize_grace_minutes'] },
  { id: 'comparison', title: 'Comparison', keys: ['detection.deviation_threshold_m', 'detection.distance_min_segment_m'] },
];

/** rows from GET /api/settings -> groups of detection.* rows; unknown detection.* keys go to "Other". */
export function groupDetectionSettings(rows = []) {
  const byKey = new Map(rows.filter((r) => r.setting_key.startsWith('detection.')).map((r) => [r.setting_key, r]));
  const used = new Set();
  const out = GROUPS.map((g) => ({
    ...g,
    rows: g.keys.filter((k) => byKey.has(k)).map((k) => { used.add(k); return byKey.get(k); }),
  }));
  const rest = [...byKey.keys()].filter((k) => !used.has(k)).sort().map((k) => byKey.get(k));
  if (rest.length) out.push({ id: 'other', title: 'Other', rows: rest });
  return out.filter((g) => g.rows.length);
}

/** Which input to render for a JSON Schema. */
export function fieldKind(schema = {}) {
  const s = baseSchema(schema);
  if (s.type === 'boolean') return 'boolean';
  if (s.enum) return 'enum';
  if (s.type === 'number' || s.type === 'integer') return 'number';
  return 'text';
}

const baseSchema = (schema = {}) => (schema.anyOf ? schema.anyOf.find((x) => x.type !== 'null') || {} : schema);
export const isNullable = (schema = {}) => Boolean(schema.anyOf?.some((x) => x.type === 'null'));

/** Human range text: "5 – 200", "integer 1 – 10", "optional, 0 – 200". */
export function rangeText(schema = {}) {
  const s = baseSchema(schema);
  if (s.enum) return `one of: ${s.enum.join(', ')}`;
  if (s.type !== 'number' && s.type !== 'integer') return '';
  const parts = [];
  if (isNullable(schema)) parts.push('optional (blank = off)');
  if (s.type === 'integer') parts.push('whole number');
  if (s.minimum !== undefined && s.maximum !== undefined) parts.push(`${s.minimum} – ${s.maximum}`);
  else if (s.minimum !== undefined) parts.push(`≥ ${s.minimum}`);
  else if (s.maximum !== undefined) parts.push(`≤ ${s.maximum}`);
  return parts.join(', ');
}

/** Raw form input -> { value } or { error } using the schema. */
export function parseSettingInput(schema = {}, raw) {
  const kind = fieldKind(schema);
  const s = baseSchema(schema);
  if (kind === 'boolean') return { value: raw === true || raw === 'true' };
  if (kind === 'enum') return s.enum.includes(raw) ? { value: raw } : { error: `Choose one of: ${s.enum.join(', ')}` };
  if (kind === 'number') {
    const str = String(raw ?? '').trim();
    if (str === '') return isNullable(schema) ? { value: null } : { error: 'A value is required' };
    const n = Number(str);
    if (!Number.isFinite(n)) return { error: 'Enter a number' };
    if (s.type === 'integer' && !Number.isInteger(n)) return { error: 'Enter a whole number' };
    if (s.minimum !== undefined && n < s.minimum) return { error: `Must be at least ${s.minimum}` };
    if (s.maximum !== undefined && n > s.maximum) return { error: `Must be at most ${s.maximum}` };
    return { value: n };
  }
  return { value: raw };
}

export const toInputString = (v) => (v === null || v === undefined ? '' : String(v));

/** Field-trial starting point, copied from workflow-docs/detection-tuning.md §4 / §4b. Read-only guidance. */
export const RECOMMENDED_START = [
  ['detection.radius_m', '30', 'Keeps false hits on neighbouring houses near 0. Try 40 only if the field trial shows many candidate/missed PIDs on clearly visited streets; avoid ≥ 50 on dense streets.'],
  ['detection.confirmation_mode', 'consecutive_points', 'The clearest rule for officials.'],
  ['detection.consecutive_points', '2', '1 would turn every candidate into confirmed.'],
  ['detection.max_gps_age_s', '300', 'Together with late_points_policy.'],
  ['detection.late_points_policy', 'evidence_only', 'Use "accept" only for trackers that buffer offline and upload later.'],
  ['detection.max_speed_kmh', '40', 'Ignores points from fast transit stretches.'],
  ['detection.segment_evidence_enabled', 'true', 'Missed 66.9 % → 6.6 % at 30 s polling; segments only ever give CANDIDATE.'],
  ['GPS poll interval', '≤ 10–15 s', 'The single most effective setting (provider side).'],
];
