// GPS ingestion pipeline (GUIDE #6 C). SET-BASED: a poll costs at most
//   1. INSERT gps_poll_runs (RUNNING)
//   2. device->vehicle map (only when the cache is stale; usually 0)
//   3. one INSERT ... SELECT unnest(...) per 5,000 points, with the vehicle_latest_locations upsert
//      in the same statement (CTE)
//   4. UPDATE gps_poll_runs (outcome + counts)
// round trips, regardless of the number of vehicles (≤ 5 for ≤ 10,000 points).
import { env } from '../../config/env.js';
import { normalizeBatch } from './gpsNormalizationService.js';
import { gpsEvents } from './gpsEvents.js';

export const INSERT_CHUNK = 5000;

/**
 * Device -> vehicle cache. Refreshed every `refreshPolls` polls, or early when an unknown device shows
 * up and the cache is older than `minAgeMs` (a newly mapped device is picked up within ~1 minute;
 * worst-case staleness for a REMOVED mapping is refreshPolls × poll interval, default 10 min).
 */
export function createDeviceCache({ refreshPolls = env.GPS_DEVICE_CACHE_POLLS, minAgeMs = 60_000, now = () => Date.now() } = {}) {
  let map = null;
  let loadedAt = 0;
  let pollsSince = Infinity;
  return {
    async get(db, { forceIfOlderThanMin = false } = {}) {
      const stale = !map || pollsSince >= refreshPolls || (forceIfOlderThanMin && now() - loadedAt > minAgeMs);
      if (stale) {
        const { rows } = await db.query('SELECT id, gps_device_id, status FROM vehicles WHERE gps_device_id IS NOT NULL');
        map = new Map(rows.map((r) => [String(r.gps_device_id), { id: r.id, status: r.status }]));
        loadedAt = now();
        pollsSince = 0;
      }
      return map;
    },
    tick() { pollsSince++; },
    invalidate() { map = null; },
  };
}

const COLS = [
  ['vehicle_id', 'int'], ['device_id', 'text'], ['latitude', 'numeric'], ['longitude', 'numeric'],
  ['speed', 'numeric'], ['heading', 'numeric'], ['ignition', 'boolean'], ['gps_accuracy', 'numeric'],
  ['provider_status', 'text'], ['recorded_at', 'timestamptz'], ['raw_payload', 'jsonb'], ['provider', 'text'],
];

const INGEST_SQL = `
WITH input AS (
  SELECT * FROM unnest(${COLS.map(([, t], i) => `$${i + 1}::${t}[]`).join(', ')})
    AS t(${COLS.map(([c]) => c).join(', ')})
),
ins AS (
  INSERT INTO gps_locations (${COLS.map(([c]) => c).join(', ')})
  SELECT ${COLS.map(([c]) => c).join(', ')} FROM input
  ON CONFLICT (vehicle_id, recorded_at) DO NOTHING
  RETURNING id, vehicle_id, latitude, longitude, speed, ignition, provider_status, recorded_at, provider
),
newest AS (
  SELECT DISTINCT ON (vehicle_id) * FROM ins ORDER BY vehicle_id, recorded_at DESC
),
latest AS (
  INSERT INTO vehicle_latest_locations
    (vehicle_id, gps_location_id, latitude, longitude, speed, ignition, provider_status, recorded_at, received_at, provider)
  SELECT vehicle_id, id, latitude, longitude, speed, ignition, provider_status, recorded_at, now(), provider FROM newest
  ON CONFLICT (vehicle_id) DO UPDATE SET
    gps_location_id = EXCLUDED.gps_location_id, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
    speed = EXCLUDED.speed, ignition = EXCLUDED.ignition, provider_status = EXCLUDED.provider_status,
    recorded_at = EXCLUDED.recorded_at, received_at = EXCLUDED.received_at, provider = EXCLUDED.provider
  WHERE EXCLUDED.recorded_at > vehicle_latest_locations.recorded_at   -- never move a vehicle backwards
  RETURNING vehicle_id
)
SELECT COALESCE((SELECT array_agg(id ORDER BY id) FROM ins), '{}') AS inserted_ids,
       COALESCE((SELECT array_agg(DISTINCT vehicle_id) FROM ins), '{}') AS vehicle_ids,
       (SELECT count(*) FROM latest) AS latest_updated`;

/**
 * Inserts validated points (vehicle_id resolved). One statement per INSERT_CHUNK points.
 * @returns {{ insertedIds: number[], vehicleIds: number[], latestUpdated: number, statements: number }}
 */
export async function ingestBatch(db, points, { provider, storeRaw = env.GPS_STORE_RAW } = {}) {
  const result = { insertedIds: [], vehicleIds: new Set(), latestUpdated: 0, statements: 0 };
  for (let i = 0; i < points.length; i += INSERT_CHUNK) {
    const chunk = points.slice(i, i + INSERT_CHUNK);
    const arrays = COLS.map(() => []);
    for (const p of chunk) {
      const row = {
        ...p,
        heading: p.heading ?? null,
        gps_accuracy: p.gps_accuracy ?? null,
        raw_payload: storeRaw ? JSON.stringify(p.raw ?? null) : null,
        provider: provider ?? null,
      };
      COLS.forEach(([c], k) => arrays[k].push(row[c] ?? null));
    }
    // eslint-disable-next-line no-await-in-loop -- chunks are sequential by design (bounded statement size)
    const { rows } = await db.query(INGEST_SQL, arrays);
    result.statements++;
    result.insertedIds.push(...rows[0].inserted_ids.map(Number));
    for (const v of rows[0].vehicle_ids) result.vehicleIds.add(Number(v));
    result.latestUpdated += Number(rows[0].latest_updated);
  }
  return { ...result, vehicleIds: [...result.vehicleIds] };
}

/**
 * One full poll cycle: run record -> fetch -> normalize/validate -> ingest -> finish run -> emit.
 * Never throws for provider problems: the run is recorded as FAILED and the error is returned.
 */
export async function pollOnce({ db, provider, deviceCache, trigger = 'SCHEDULED', signal, now = () => new Date(), futureToleranceS = env.GPS_FUTURE_TOLERANCE_SECONDS }) {
  const t0 = Date.now();
  const run = (await db.query(
    "INSERT INTO gps_poll_runs (provider, trigger) VALUES ($1, $2) RETURNING id", [provider.name, trigger])).rows[0];
  const summary = { pollRunId: run.id, provider: provider.name, trigger, received: 0, saved: 0, rejected: 0, duplicates: 0, rejected_breakdown: {}, outcome: 'FAILED', error: null };

  try {
    let deviceMap = await deviceCache.get(db);
    const raw = await provider.fetchLatest({ deviceIds: [...deviceMap.keys()], signal });
    summary.received = raw.length;
    let { valid, rejected } = normalizeBatch(raw, provider, { now: now(), futureToleranceS, deviceMap });

    if (rejected.UNKNOWN_DEVICE) {
      // A device may have been mapped since the cache was loaded: refresh at most once per minute.
      const fresh = await deviceCache.get(db, { forceIfOlderThanMin: true });
      if (fresh !== deviceMap) {
        deviceMap = fresh;
        ({ valid, rejected } = normalizeBatch(raw, provider, { now: now(), futureToleranceS, deviceMap }));
      }
    }
    deviceCache.tick();

    const ing = await ingestBatch(db, valid, { provider: provider.name });
    summary.saved = ing.insertedIds.length;
    summary.rejected = Object.values(rejected).reduce((a, b) => a + b, 0);
    summary.duplicates = valid.length - summary.saved;
    summary.rejected_breakdown = rejected;
    summary.outcome = summary.rejected > 0 ? 'PARTIAL' : 'SUCCESS';
    summary.latestUpdated = ing.latestUpdated;
    summary.insertStatements = ing.statements;

    await finishRun(db, summary);
    if (ing.insertedIds.length) {
      gpsEvents.emit('ingested', { pollRunId: run.id, provider: provider.name, insertedIds: ing.insertedIds, vehicleIds: ing.vehicleIds });
    }
  } catch (err) {
    summary.outcome = 'FAILED';
    summary.error = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? `Provider timeout/abort: ${err.message}` : String(err?.message || err);
    await finishRun(db, summary).catch(() => {}); // even recording can fail (DB down) — never throw from here
  }
  summary.durationMs = Date.now() - t0;
  return summary;
}

function finishRun(db, s) {
  return db.query(
    `UPDATE gps_poll_runs SET finished_at = now(), outcome = $2, records_received = $3, records_saved = $4,
            records_rejected = $5, rejected_breakdown = $6, error_message = $7 WHERE id = $1`,
    [s.pollRunId, s.outcome, s.received, s.saved, s.rejected, s.rejected_breakdown, s.error],
  );
}
