// PostgreSQL pool + helpers. All SQL elsewhere must be parameterized ($1..$n).
import pg from 'pg';
import { env } from './env.js';

// Return BIGINT (int8) and NUMERIC as JS numbers for API ergonomics. Safe for our ranges
// (ids < 2^53, coordinates NUMERIC(10,7)). COUNT(*) is also int8.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

// When DB_SCHEMA is set (tests), we connect via Neon's *unpooled* host because the pooler (PgBouncer)
// rejects the `search_path` startup option; normal runs (no DB_SCHEMA) keep using the pooled host.
// `unpooled: true` forces the direct host without changing search_path — needed for session-level
// state such as the GPS poller's pg_advisory_lock (PgBouncer transaction mode would not keep it).
export function buildConnectionConfig({ url = env.DATABASE_URL, schema = env.DB_SCHEMA, unpooled = false } = {}) {
  const u = new URL(url);
  // Explicit verify-full: current pg behaviour for sslmode=require, without the deprecation warning.
  u.searchParams.set('sslmode', 'verify-full');
  const config = {
    max: env.DB_POOL_MAX,
    // Serverless Postgres / NAT gateways silently drop idle TCP connections. Keepalive + closing our
    // own idle clients after 10 s avoids handing out a dead socket (ECONNRESET on the next query).
    keepAlive: true,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  };
  if (schema || unpooled) u.hostname = u.hostname.replace('-pooler.', '.');
  if (schema) config.options = `-c search_path=${schema},public`;
  config.connectionString = u.toString();
  return config;
}

export const pool = new pg.Pool(buildConnectionConfig());

// An idle client dying (network drop, server restart) emits 'error' on the pool. Without a listener
// Node treats it as an unhandled 'error' event and crashes the process. The pool discards that client
// and creates a fresh one on demand, so logging is enough here.
pool.on('error', (err) => {
  // Lazy import avoids a config <-> logger import cycle at module load.
  import('../utils/logger.js').then(({ logger }) => logger.warn({ err: err.message }, 'Idle database client error (discarded)'));
});

/** Default query executor; repositories accept `db` or a transaction client interchangeably. */
export const db = {
  query: (text, params) => pool.query(text, params),
};

/** Run fn(client) inside a transaction. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
