// Validated environment configuration — the single source of config for the app.
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Optional schema isolation (used by tests). Forces the unpooled Neon host because the
  // pooler rejects the search_path startup parameter.
  DB_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/, 'DB_SCHEMA must be a lowercase identifier')
    .optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  // ---- GPS (Phase 3) — see workflow-docs/gps-provider-integration.md
  GPS_PROVIDER: z.string().default('simulator'),
  GPS_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  GPS_POLL_ENABLED: bool.default(false),
  GPS_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  GPS_PROVIDER_TIMEZONE: z.string().default('Asia/Kolkata'),
  GPS_FUTURE_TOLERANCE_SECONDS: z.coerce.number().int().nonnegative().default(120),
  GPS_STORE_RAW: bool.default(false),
  GPS_DEVICE_CACHE_POLLS: z.coerce.number().int().positive().default(10),
  GPS_SIM_SEED: z.coerce.number().int().default(42),
  GPS_SIM_SPEED_KMH: z.coerce.number().positive().default(15),
  GPS_SIM_JITTER_M: z.coerce.number().nonnegative().default(8),
  GPS_SIM_DROPOUT_PCT: z.coerce.number().min(0).max(100).default(0),
  GPS_SIM_DUPLICATE_PCT: z.coerce.number().min(0).max(100).default(0),
  GPS_SIM_OUT_OF_ORDER_PCT: z.coerce.number().min(0).max(100).default(0),
  GPS_SIM_LATE_PCT: z.coerce.number().min(0).max(100).default(0),
  GPS_SIM_BAD_PCT: z.coerce.number().min(0).max(100).default(0),
  GPS_SIM_OFFLINE_VEHICLES: z.string().default(''),
  GPS_SIM_PLAN_REFRESH_POLLS: z.coerce.number().int().positive().default(10),
  // ---- PID detection (Phase 4). Worker defaults to running wherever GPS polling runs.
  DETECTION_WORKER_ENABLED: bool.optional(),
  DETECTION_BATCH_SIZE: z.coerce.number().int().min(100).max(50_000).default(5000),
  DETECTION_CATCHUP_SECONDS: z.coerce.number().int().positive().default(60),
  DETECTION_FINALIZE_MINUTES: z.coerce.number().int().positive().default(15),
  // ---- GPS data lifecycle (Phase 7a): partition pre-creation + retention job.
  GPS_LIFECYCLE_ENABLED: bool.default(true),
  // ---- Reports (Phase 6). Daily archive runs where the detection worker runs unless set explicitly.
  REPORTS_ARCHIVE_ENABLED: bool.optional(),
  REPORTS_DAILY_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm').default('06:00'),
  REPORTS_WAIT_UNTIL: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm').default('12:00'),
  REPORTS_DIR: z.string().default('storage/reports'),
  REPORTS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  REPORTS_EXPORTS_PER_MIN: z.coerce.number().int().positive().default(5),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY: bool.default(false),
  LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(5),
  IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(50_000),
  IMPORT_MAX_FILE_MB: z.coerce.number().positive().max(50).default(10),
});

// Values copied from .env.example (or obviously placeholder) must never reach production.
const PLACEHOLDER_SECRET = /^<.*>$|generate|change[-_ ]?me|example|placeholder|secret$/i;

/**
 * Production-only safety rules (GUIDE #11 C5). Startup FAILS on any of them.
 * `raw` is the untouched source, needed to tell "TRUST_PROXY not set" from "set to false".
 */
export function productionProblems(e, raw) {
  if (e.NODE_ENV !== 'production') return [];
  const problems = [];
  if (Buffer.byteLength(e.JWT_SECRET, 'utf8') < 32) problems.push('JWT_SECRET must be at least 32 bytes');
  if (PLACEHOLDER_SECRET.test(e.JWT_SECRET)) problems.push('JWT_SECRET is a placeholder value (generate one: openssl rand -hex 32)');
  if (e.GPS_PROVIDER === 'simulator') problems.push('GPS_PROVIDER=simulator is not allowed in production');
  const origins = e.CORS_ORIGIN.split(',').map((s) => s.trim());
  if (origins.some((o) => o === '*' || o.includes('*'))) problems.push('CORS_ORIGIN must not contain a wildcard (*)');
  if (origins.some((o) => /\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|$|\/)/i.test(o))) problems.push('CORS_ORIGIN must not contain localhost origins');
  if (raw.TRUST_PROXY === undefined || raw.TRUST_PROXY === '') problems.push('TRUST_PROXY must be set explicitly (true behind nginx / a load balancer, false otherwise)');
  return problems;
}

/** Parses + validates an env source (process.env by default). Throws with every problem listed. */
export function parseEnv(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const prod = productionProblems(parsed.data, source);
  if (prod.length) throw new Error(`Unsafe production configuration:\n${prod.map((p) => `  - ${p}`).join('\n')}`);
  return Object.freeze(parsed.data);
}

export const env = parseEnv();
