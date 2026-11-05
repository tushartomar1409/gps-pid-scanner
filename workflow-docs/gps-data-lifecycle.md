# GPS data lifecycle: partitioning and retention (GUIDE #11 A)

**Why:** 2,000 vehicles × one point every 30 s ≈ **5.76 M `gps_locations` rows per day, ≈ 173 M per month, ≈ 2.1 B per year**. A single heap with 4 indexes cannot be pruned or expired cheaply at that size, and Neon bills storage. Restructuring now is cheapest: `public` holds **0 GPS rows**.

## 1. Design

### 1.1 Monthly range partitions (`0009_gps_partitioning.sql`)
- `gps_locations` is `PARTITION BY RANGE (recorded_at)`.
  - Partitions are named `gps_locations_pYYYY_MM`.
  - Bounds are **IST month starts**: `[YYYY-MM-01 00:00 +05:30, next month 00:00 +05:30)`, so an operational day never straddles two partitions.
- **Keys:**
  - PK `(id, recorded_at)`, since a partitioned PK must contain the partition key.
  - `UNIQUE (vehicle_id, recorded_at)` is unchanged: it already contains the key, and ingest's `ON CONFLICT (vehicle_id, recorded_at)` keeps working.
  - Ids come from an explicit sequence, `gps_locations_id_seq`, so they stay globally unique.
- **Indexes:** the same secondary indexes as before, now per partition: unprocessed (partial), received_at, recorded_at, provider (partial).
- **DEFAULT partition** `gps_locations_default`: a row whose month has no partition lands here instead of failing ingest. The lifecycle job **alerts** when it is not empty, by logging an error and reporting `default_rows` in health details.
- **SQL helpers.** Identifiers are built only with `format('%I')` from dates, never from caller input.
  - `gps_ensure_partitions(from date, months int, tz)` is idempotent and returns the names it created.
  - `gps_partitions()` returns name, is_default, range_from/to, est_rows and total_bytes.
  - `gps_drop_partitions_before(cutoff)` does DETACH + DROP of every monthly partition whose **whole** range ends at or before the cutoff. It never touches DEFAULT.
- **At migration time:** the previous month up to 2 months ahead (4 partitions).

### 1.2 The FK problem → self-contained evidence
A foreign key can't reference `gps_locations(id)` alone once the table is partitioned (the PK is `(id, recorded_at)`), and old partitions get dropped anyway. So:
- `pid_visit_events.gps_location_id` and `vehicle_latest_locations.gps_location_id` are **plain bigints** now; their FKs are dropped.
- **`pid_visit_events` carries its own copy of the point:** `gps_recorded_at`, `gps_latitude`, `gps_longitude`, `gps_speed` (all NOT NULL except speed). The detector fills them at insert time. For `TRACK_SEGMENT`, they describe the **later** point of the segment.
- `vehicle_latest_locations` gained `heading`, so the socket's location push no longer joins `gps_locations`.
- **Every evidence reader uses only event columns:**
  - `/api/pid-visits`, the PID drawer on the coverage map, and the reports' detection evidence and missed PIDs;
  - the dashboard's hourly *visit events*;
  - status recompute (`RECOMPUTE_SQL` → `evid` from `pid_visit_events`).
- **Raw-GPS readers** (history, comparison track and distance, dashboard "has GPS today" / first-last GPS / hourly points, reports' first/last GPS and active vehicles) show nothing for days whose raw GPS has expired. That is by design, and it is documented.

### 1.3 Retention job (`src/services/gps/gpsLifecycleService.js`)
- **Setting:** `gps.retention_days` (default **180**, minimum 35 so the current and previous month are always kept), editable on Detection Settings via `PUT /api/settings`.
- **`runGpsLifecycle()`**, under a transaction-scoped advisory lock (one instance at a time, pooler-safe):
  1. `gps_ensure_partitions(current IST month, 3)`: the current month + **2 ahead**. A failure (for example DEFAULT already holds rows of that month) is caught and turned into an alert.
  2. `gps_drop_partitions_before(now − retention_days)`: **whole-partition drops, never a row DELETE**, so each costs about the same however many rows it holds.
  3. Count the DEFAULT rows → an alert if > 0.
- **Schedule:** at start (+2 s), then every 6 h, on every instance (lock-guarded). It runs even with polling off, so next month's partition always exists. `GPS_LIFECYCLE_ENABLED=false` disables it.

### 1.4 Reprocess on an aged-out day → 409
`reprocessOne` first checks the assignment window against `retainedFrom()`, the start of the oldest monthly partition. If the window starts earlier, it returns **409 "Raw GPS no longer retained … reprocessing would delete its visit evidence without being able to rebuild it"**. This check runs **before** any event is deleted or any status is reset.

## 2. Effect on every query that touches `gps_locations`
All of them filter by `recorded_at` (or `id` + `recorded_at`), so the planner prunes, either at plan time (constants or parameters) or at run time (per nested-loop probe / init-plan values). The EXPLAIN evidence is in §4.

| # | Query | Where | Pruning |
|---|---|---|---|
| 1 | Ingest `INSERT … ON CONFLICT (vehicle_id, recorded_at)` | `gpsTrackerService` | Tuple routing by `recorded_at`; the unique check is per partition. |
| 2 | Detector claim `WHERE processed_at IS NULL ORDER BY vehicle_id, recorded_at LIMIT n FOR UPDATE SKIP LOCKED` | `pidDetectionService` Q1 `batch` | No time bound by design (the backlog can be in any month). A Merge Append over each partition's **partial** `idx_gps_unprocessed`, which is empty for fully processed months, so each costs one empty index probe. |
| 3 | Neighbour prev/next (segment evidence) | Q1 `nbr` | **Bounded to ± segment_max_gap_s** (new), so run-time pruning per probe hits 1, or at a month edge 2, partitions. Same result as before: a neighbour further away can never form a segment. |
| 4 | Mark processed `WHERE id = ANY(batch ids)` | Q1 `done` | **New `recorded_at` between min/max of the batch** → run-time pruning via init-plan params. |
| 5 | Adjacency `NOT EXISTS (vehicle_id, recorded_at in (prev_at, detected_at))` | Q2 `adj` | Range on `recorded_at` → per-probe pruning. |
| 6 | History / vehicle-history, comparison track + distance + deviation | `gpsReadService`, `routeComparisonService` | `recorded_at` BETWEEN the window → plan-time pruning (tested). |
| 7 | Dashboard "has GPS on date", first/last GPS, hourly points | `dashboardService` | IST day window → pruned. |
| 8 | Reports: active vehicles, first/last GPS, vehicle-tracking | `reports/definitions` | Day window → pruned. |
| 9 | Finalizer `NOT EXISTS` unprocessed / any point in the window | `coverageFinalizationService` | Assignment window → pruned. |
| 10 | Reprocess `UPDATE … processed_at = NULL` in the window | `coverageFinalizationService` | Window → pruned; refused (409) for expired windows. |
| 11 | Purge script (`provider = 'simulator'`) | `scripts/gps-purge-sim.js` | By design it scans every partition through the partial provider index. It is a manual dev tool. |
| 12 | Socket location push | `socketServer` | **No longer touches `gps_locations`** (heading moved to latest). |

## 3. Storage estimate (measured)
`npm run perf:gps` inserts one day at 30 s for 200 vehicles (**595,957 rows**) into the current month's partition, with realistic columns (speed, heading, ignition, provider, processed) and `raw_payload` off (`GPS_STORE_RAW=false`). Then it runs `VACUUM ANALYZE` and measures:

| | bytes / row |
|---|---|
| heap | **134** |
| indexes (total) | **121** |
| ↳ `UNIQUE (vehicle_id, recorded_at)` | 54 |
| ↳ PK `(id, recorded_at)` | 32 |
| ↳ `recorded_at` | 14 |
| ↳ `received_at` | 14 |
| ↳ `provider` (partial) | 6 |
| ↳ unprocessed (partial) | ~0–1 once processed |
| **total** | **255** |

At **2,000 vehicles × 30 s = 172.8 M rows / month**:
- **≈ 41 GiB per month**;
- **≈ 246 GiB at the default 180-day retention** (6 monthly partitions plus the current one being filled);
- double that with `GPS_STORE_RAW=true` (raw JSON is typically 150–300 B/row), so keep it off in production;
- at 15 s polling the figures double; at 60 s they halve.

Visit evidence is small by comparison (about 10 events per assigned PID per day, about 150 B/row) and is **not** dropped with raw GPS.

Levers, if storage becomes a cost problem:
1. Shorter `gps.retention_days` (90 → ≈ 123 GiB).
2. Drop `idx_gps_received` and `idx_gps_recorded_at` (28 B/row, −11 %). Nothing hot uses `received_at`, and `recorded_at` alone is covered by the unique index for per-vehicle access. Dashboard and report day-window scans would need checking first.
3. Drop the provider partial index (6 B/row): every row has a provider, so it is effectively full. It only serves the dev purge script.

## 4. EXPLAIN evidence (partition pruning)
- **Tests:** `tests/integration/gpsLifecycle.test.js` "time-bounded GPS queries prune" asserts that `EXPLAIN (FORMAT JSON)` of:
  - the history query for 2031-08-10 touches **only `gps_locations_p2031_08`**;
  - an adjacency-style range touches **only `gps_locations_p2031_09`**.
- **Perf** (`perf:detect`, 2,000 vehicles, 20k points, EXPLAIN ANALYZE of a real 5k batch):
  - **Mark processed (`done`):** the batch-bounds init-plan prunes at run time, so the other partitions show `(never executed)`.
  - **Neighbour lookups (prev/next):** per-probe run-time pruning; the off-month partitions are `never executed`.
  - **Adjacency:** Index Only Scan on `gps_locations_p2026_11_vehicle_id_recorded_at_key` (loops = 2000), and only that partition.
  - **Claim batch:** scans each partition's unprocessed rows (empty partitions cost about 0.002 ms each).
- **perf:gps (2,000 vehicles):**
  - live-vehicles: Execution **11.7 ms** (was 11.5 ms unpartitioned);
  - vehicle-history for one day: **3.1 ms** (was 3.1 ms);
  - ingest: **3 round trips per warm cycle** (unchanged), ~0.93 s per cycle.

## 5. Applying it to `public`
`0009` aborts unless `gps_locations` and `pid_visit_events` are both empty. Counts observed immediately before it was applied (2026-11-05 17:43:16 UTC): `gps_locations` 0, `pid_visit_events` 0, `vehicle_latest_locations` 0, `gps_poll_runs` 0. It was applied with `npm run migrate`. `public` now has `gps_locations_p2026_10 … p2027_01` plus `gps_locations_default`.

## 6. Operations
- `GET /api/health/details` (SUPER_ADMIN) lists every partition with its estimated rows and size, `retained_from`, `default_rows` with an alert, and the last lifecycle run. The same data is on the **GPS Integration → Operations** card.
- **Manual:**
  - `SELECT * FROM gps_partitions();`
  - `SELECT gps_ensure_partitions('2027-02-01', 3);`
  - `SELECT gps_drop_partitions_before(now() - interval '180 days');` (the job does this; use it manually only to free space at once).
- **Rows in DEFAULT:** create the missing month with `gps_ensure_partitions`. If DEFAULT already holds rows of that month, PostgreSQL refuses to create the partition. Move them out first (in a transaction: `INSERT … SELECT` from DEFAULT into the new month's range, after detaching DEFAULT), and ask before doing this on production.
