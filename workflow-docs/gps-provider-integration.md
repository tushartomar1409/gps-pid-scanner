# GPS provider integration

How GPS data gets into the portal, how to plug in the real provider, and how to run the simulator.
Code: `be/src/services/gps/`, `be/src/jobs/gpsPollingJob.js`.

```
provider adapter --fetchLatest--> raw records --adapter.normalize--> NormalizedPoint
   --gpsNormalizationService.validatePoint--> valid points (rejects counted by reason)
   --gpsTrackerService.ingestBatch--> gps_locations + vehicle_latest_locations (one statement per 5,000 points)
   --gpsEvents 'ingested'--> Phase 4 detection, Phase 5 Socket.IO
```

The pipeline is **provider-agnostic**. Only the adapter knows the provider's URLs, auth and field names.

---

## 1. Adapter contract

```js
{
  name: 'acmetrack',                                         // stored in gps_poll_runs.provider and gps_locations.provider
  fetchLatest({ deviceIds, signal }) -> Promise<raw[]>,      // latest record per device; honour `signal`
  fetchHistory({ deviceId, from, to, signal }) -> Promise<raw[]>,
  normalize(raw) -> { ok: NormalizedPoint } | { error: 'NO_TIMESTAMP' | 'BAD_TIMESTAMP' | ... },
}
```

`NormalizedPoint` (flow.txt §7):

```
{ device_id, vehicle_number?, latitude, longitude, speed (km/h | null), ignition (bool | null),
  heading?, gps_accuracy?, recorded_at (Date = device fix time), provider_status, raw }
```

- `normalize` should only map fields and parse the timestamp. Use `parseProviderTimestamp(value, env.GPS_PROVIDER_TIMEZONE)`, which accepts ISO with `Z` or an offset, epoch seconds or milliseconds, and naive local strings.
- Generic validation then runs centrally, so adapters must **not** duplicate it. Each rejected point is counted in `gps_poll_runs.rejected_breakdown` under one of these codes:
  - `INVALID_COORDS`: out of range, NaN, or exactly 0,0
  - `FUTURE_TIMESTAMP`: more than `GPS_FUTURE_TOLERANCE_SECONDS` ahead of now
  - `NEGATIVE_SPEED`
  - `UNKNOWN_DEVICE`
  - `NO_TIMESTAMP` / `BAD_TIMESTAMP`
- Late and out-of-order points are **stored**, not rejected. `vehicle_latest_locations` never moves backwards.

## 2. Adding the real provider, step by step

1. Get the provider details listed in §3 from the client. **Do not guess the API** (flow.txt §27 rule 10).
2. Copy `be/src/services/gps/providers/httpProviderTemplate.js` to `<name>Provider.js` and fill in every `TODO`:
   - auth (token caching and refresh)
   - endpoints and pagination
   - field mapping and unit conversions (speed to km/h)
   - which timestamp is the **device fix time**
3. Add the provider's credentials and base URL to `be/src/config/env.js` (zod schema) and to `be/.env.example` with placeholders. Credentials live only in `be/.env`, never in the frontend.
4. Register the factory in `be/src/services/gps/providers/index.js` (`REGISTRY`).
5. Write unit tests for `normalize()` using the provider's **real sample responses**, including an offline device, missing fields and an error payload. Put them under `be/tests/unit/`.
6. Set `GPS_PROVIDER=<name>` and `GPS_POLL_ENABLED=true`, then check `GET /api/gps/provider-status` and `POST /api/gps/poll-now`.
7. Map every vehicle's `gps_device_id` to the provider's device identifier (Vehicles page).
8. Tune `GPS_POLL_INTERVAL_SECONDS` to the provider's rate limits and data frequency.

An unknown `GPS_PROVIDER` makes the server refuse to start, listing the registered names.

## 3. Information we need from the client / provider

1. The provider name, API documentation, and sandbox or test credentials.
2. **Auth method:** API key header, Basic auth, OAuth2 client credentials, or a login session token. Token lifetime and how to refresh it.
3. **Base URLs** for production and sandbox, and any IP whitelisting (our server's egress IP).
4. **Endpoints:**
   - list devices
   - latest location of all devices (bulk, ideally)
   - history for one device between from and to
   - device online/offline status
5. **Sample responses** (real JSON or XML) for every endpoint, including an offline device and an error response.
6. **Field mapping:**
   - the device ID field (IMEI or a provider-side ID) and the registration-number field
   - lat/lng format (decimal degrees or NMEA)
   - speed unit (km/h, knots or m/s)
   - ignition/ACC, heading, accuracy/HDOP/satellites
   - the provider's status codes
7. **Timestamps:**
   - field name and format (ISO, epoch seconds or epoch milliseconds)
   - **timezone** (UTC or IST, with or without an offset)
   - whether it is the device fix time or the server receive time
8. **Rate limits:** requests per minute, maximum devices per call, pagination, and what happens when the limit is exceeded (429 or a ban).
9. **Data frequency:** how often devices report while moving, while idle, and with ignition off.
10. Whether **push/webhook** delivery is available, its payload format, and how to verify its signature.
11. History limits: the maximum time range per request, and how long data is retained.
12. Whether several providers are used across agencies. If so, we need per-vehicle adapter routing.
13. Error semantics, the SLA/uptime, and a support contact for when the API is down.

## 4. Environment variables (backend)

| Variable | Default | Meaning |
|---|---|---|
| `GPS_PROVIDER` | `simulator` | Adapter name from the registry. The simulator refuses to load when `NODE_ENV=production`. |
| `GPS_POLL_ENABLED` | `false` | Start the polling job in `npm start` / `npm run dev`. Tests never start it. |
| `GPS_POLL_INTERVAL_SECONDS` | `60` | Delay between successful polls. Runs never overlap (chained `setTimeout`). |
| `GPS_PROVIDER_TIMEOUT_MS` | `15000` | Abort a provider call after this long. The run is recorded as FAILED. |
| `GPS_PROVIDER_TIMEZONE` | `Asia/Kolkata` | Timezone for **naive** provider timestamps. |
| `GPS_FUTURE_TOLERANCE_SECONDS` | `120` | Points further in the future than this are rejected (`FUTURE_TIMESTAMP`). |
| `GPS_STORE_RAW` | `false` | Store the raw provider record in `gps_locations.raw_payload` (debugging; costs storage). |
| `GPS_DEVICE_CACHE_POLLS` | `10` | Device-to-vehicle map cache lifetime, in polls. Refreshed early (at most once a minute) when an unknown device appears. A removed mapping can stay in use for up to this many polls. |
| `GPS_SIM_SEED` | `42` | Simulator PRNG seed. The same seed and tick give identical points. |
| `GPS_SIM_SPEED_KMH` | `15` | Simulated vehicle speed. |
| `GPS_SIM_JITTER_M` | `8` | Random GPS noise radius. |
| `GPS_SIM_DROPOUT_PCT` | `0` | % of vehicle-polls with no point. |
| `GPS_SIM_DUPLICATE_PCT` | `0` | % of points sent twice. |
| `GPS_SIM_OUT_OF_ORDER_PCT` | `0` | % of polls that also send an older point (60–120 s back). |
| `GPS_SIM_LATE_PCT` | `0` | % of polls that also send a point 5–30 min old. |
| `GPS_SIM_BAD_PCT` | `0` | % of points with invalid coordinates (0,0 or lat 123). |
| `GPS_SIM_OFFLINE_VEHICLES` | (empty) | Comma-separated vehicle numbers that never report. |
| `GPS_SIM_PLAN_REFRESH_POLLS` | `10` | How often the simulator reloads today's assignments. |

Related DB setting: `gps.offline_after_seconds` (default 300). Vehicles with an older latest point show as OFFLINE.

## 5. Operations

- **Single runner:** the poller holds `pg_try_advisory_lock(hashtext('gps_poll:<schema>'))` on a **dedicated unpooled** connection. Neon's pooler can't keep session locks. Extra app instances become standby and retry every 60 s. If the lock connection drops, it is re-acquired.
- **Failures:** each failed run is recorded as FAILED with its error. The next attempt backs off exponentially with full jitter (30 s → 1 m → 2 m … capped at 5 m), and the backoff resets after a success. A provider error never crashes the process.
- **Status:** `GET /api/gps/provider-status`:
  - `DOWN`: ≥ 3 consecutive failures, or no successful run within 5 intervals
  - `DEGRADED`: the last run was PARTIAL, or > 20 % of its points were rejected
  - `UP`: otherwise

  The header badge in the UI shows this state.
- **Manual run:** `POST /api/gps/poll-now` (SUPER_ADMIN, once per 30 s). It goes through the same lock.
- **Cost:** one poll is ≤ 5 database round trips, whatever the number of vehicles: run start, device map (usually cached), one insert per 5,000 points, run end. The latest-location upsert happens inside the insert statement.

## 6. Running the simulator locally (demo on the real database)

Prerequisites: vehicles with a **GPS device ID**, and **assignments for today** on routes that have PIDs (Assignments page).

```bash
cd be
# in be/.env (or the shell):
#   GPS_PROVIDER=simulator
#   GPS_POLL_ENABLED=true
#   GPS_POLL_INTERVAL_SECONDS=30          # optional, faster demo
#   GPS_SIM_OFFLINE_VEHICLES=HR38AB5678   # optional
npm run dev
```

- **Check:** the header badge turns green (UP). `GET /api/gps/live-vehicles` shows the vehicles ONLINE and moving along their routes.
- Points are written with `provider = 'simulator'`.

**Cleaning up the demo data afterwards:**

```bash
npm run gps:purge-sim               # dry run: prints what would be deleted
npm run gps:purge-sim -- --confirm  # deletes simulator gps_locations, latest locations, poll runs (+ their visit events)
```

Real-provider data is never touched by the purge.

## 7. Development checks

```bash
npm test                                   # includes GPS unit + integration tests (isolated test schema)
DB_SCHEMA=perf_gps_x npm run perf:gps      # 2,000-vehicle poll perf + EXPLAINs (throwaway schema, dropped after)
```
