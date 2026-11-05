# Phase 7 backlog

Items deferred on purpose. Each has the measurement that triggered it and a proposed fix. Not scheduled before Phase 7 unless the guide says so.

## 1. Detection throughput (logged GUIDE #9)

**Measured** with `npm run perf:detect`: 2,000 vehicles, 40,000 snapshot PIDs and 20,000 points, on Neon at about 265 ms RTT from the dev machine.

| | before segment evidence (#7) | after segments + window-count fix (#8) |
|---|---|---|
| wall per 5,000-point batch | ~3.5–4.2 s | 6.6–8.0 s |
| claim + detect EXPLAIN execution | ~0.2 s | ~1.3 s |
| recompute | ~0.33 s | ~0.56–1.1 s (depends on mode) |
| DB round trips per batch | 4 | 4 |

- **Throughput:** about 700 points/s.
- **Need:** about 67 points/s for 2,000 vehicles at 30 s, so there is roughly 10× headroom. That's acceptable for now.

**Where the time goes:**
- `seg_cand`: LATERAL probes per segment into `route_assignment_pids` (about 8k loops), plus the assignment re-resolution `SubPlan` for the neighbour point.
- `DISTINCT ON` sort.

**Ideas, to measure before applying:**
- Resolve the neighbour point's assignment once in `nbr`, not as a correlated SubPlan per pair.
- Use a bbox-of-segment prefilter on `idx_rap_ra_lat_lng`, replacing a radius around each endpoint.
- Skip segment evidence for a PID already CONFIRMED in this assignment, because it can't raise the status.
- Make the batch size adaptive. Raising the batch size (5k → 10k) halves the round-trip share.
- Run the perf job against a DB in the same region, so RTT stops dominating wall time.

## 2. Test-suite flakiness (logged GUIDE #9)

**Seen in the #8 full run:**
- A Neon connection timeout in a file's `beforeAll` and in the vitest global setup (`Connection terminated due to connection timeout`).
- A Windows worker crash, exit `0xC0000409`, while running `activityLogs.test.js`.

Both files pass on re-run.

**Proposed fix:**
- **Global setup:** retry **only the connect step** (`pool.connect()` / `client.connect()`), 3 attempts with jittered backoff. Never retry queries or migrations, so a real failure still fails loudly.
- **Pool:** set a larger `connectionTimeoutMillis` for tests only (Neon cold start).
- **Vitest:** `pool: 'forks'` with `maxWorkers: 2–3` (file parallelism is currently off). Measure the effect on the crash rate and total duration (currently ~14 min).
- Record a per-file duration baseline so slow files stand out.
