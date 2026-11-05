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
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY: bool.default(false),
  LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(5),
  IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(50_000),
  IMPORT_MAX_FILE_MB: z.coerce.number().positive().max(50).default(10),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = Object.freeze(parsed.data);
