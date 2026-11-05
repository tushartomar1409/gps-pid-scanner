# Phase 0 Proposal — GPS PID Scanner

**Author:** WORKER session · **Date:** 2026-11-05 · **Answers:** GUIDE → WORKER #1
**Inputs:** `workflow-docs/flow.txt` (spec), `workflow-docs/session_guide.md` §3 decisions D1–D7.

---

## a. Repository analysis

| Path | State |
|---|---|
| `.git` | Initialised on `main`, no commits. |
| `be/` | `dbconnection.txt` (Neon Postgres URL, git-ignored), `.env` (git-ignored), `.env.example`, `package.json` (`"type":"module"`, deps `pg`, `dotenv`), `scripts/db-check.js` (throwaway). |
| `fe/` | Empty. |
| `workflow-docs/` | `flow.txt` (spec), `session_guide.md` (pipeline), this file. |

There is no existing code, so there are no conventions to keep. The architecture below follows flow.txt §16 and decisions D1–D7.

**DB check results:** PostgreSQL **18.6** (Neon, aarch64). **PostGIS 3.6.4 is available** (`installed_version = null`, so `CREATE EXTENSION` has not run yet). This means D2's Phase 4 optimisation (a `geography(Point)` column + GIST index) can be done.

---

## b. Proposed architecture

### b.1 Folder trees

```text
be/
  package.json            # type: module
  .env / .env.example
  migrations/             # plain numbered SQL: 0001_init.sql, 0002_seed_roles.sql ...
  scripts/
    migrate.js            # runs migrations/*.sql in order inside a tx, tracks in schema_migrations
    seed-admin.js         # creates first super admin from env/CLI args
    db-check.js
  src/
    index.js              # http server + Socket.IO + job scheduler bootstrap
    app.js                # express app (helmet, cors, json, routes, error mw)
    config/
      env.js              # validated env (zod) — single source of config
      database.js         # pg.Pool, query(), withTransaction(fn)
      gpsConfig.js
    middleware/
      authMiddleware.js   # JWT verify -> req.user
      roleMiddleware.js   # requirePermission('pids:write')
      scopeMiddleware.js  # builds req.scope {zoneIds, wardIds, agencyId} for row-level filtering
      validationMiddleware.js  # zod schemas for body/query/params
      errorMiddleware.js
      rateLimit.js        # express-rate-limit on /api/auth/*
    routes/ controllers/ validators/      # one per module (auth, zones, wards, agencies, vehicles, pids, routes, routeAssignments, gps, pidVisits, dashboard, reports, settings, users, activityLogs)
    repositories/         # SQL only, parameterized ($1..$n); no business logic
    services/
      gps/
        gpsTrackerService.js       # provider-agnostic facade: fetchLatest(), fetchHistory()
        adapters/
          index.js                 # picks adapter by GPS_PROVIDER
          simulatorAdapter.js      # dev/test only (refuses to load when NODE_ENV=production)
          <realProvider>Adapter.js # after provider docs arrive
        gpsNormalizationService.js # raw -> normalized record + validation
      pidDetectionService.js       # pure engine (no provider knowledge)
      routeCoverageService.js
      settingsService.js           # cached system_settings
      reportService.js / exportService.js (exceljs, pdfkit)
      realtimeService.js           # Socket.IO emit helpers, rooms per zone/ward/agency
    jobs/
      scheduler.js                 # node-cron, single-instance lock (pg_try_advisory_lock)
      gpsPollingJob.js
      pidVisitProcessingJob.js
      dailyCoverageJob.js          # end-of-day: GPS_DATA_UNAVAILABLE / NOT_VISITED finalisation
    utils/ haversine.js, geo.js (bbox), time.js (operationalDate), responseHandler.js, logger.js (pino), errors.js
  tests/
    unit/  (haversine, normalization, detection engine, operationalDate)
    integration/ (supertest against a test schema)

fe/                       # React + Vite
  src/
    main.jsx, App.jsx
    api/       axios instance (JWT interceptor, 401 -> logout), per-module api files
    auth/      AuthContext, ProtectedRoute, permission helpers
    layouts/   AppLayout (sidebar + header)
    components/ DataTable, FilterBar, ConfirmDialog, StatusBadge, MapLegend, EmptyState, Loader
    maps/      BaseMap (configurable tile URL), VehicleMarker, PidMarker, TrailLayer, RouteLayer
    pages/     Login, Dashboard, LiveTracking, PidCoverageMap, Routes, RouteAssignments,
               masters/{Pids,Vehicles,Agencies,Zones,Wards}, reports/{...6}, HistoricalTracking,
               Users, GpsSettings, DetectionSettings, ActivityLogs
    hooks/     useSocket (reconnect + room subscribe), usePaginatedQuery
    styles/    Tailwind
```

FE libraries: react-router, axios, leaflet + react-leaflet, Tailwind, Recharts, socket.io-client, @tanstack/react-query (caching and loading states).

### b.2 Request flow

```
Browser ──HTTPS──> Express
  helmet/cors -> rateLimit(auth) -> authMiddleware(JWT) -> roleMiddleware(permission)
  -> scopeMiddleware(zone/ward/agency) -> validation(zod) -> controller -> service -> repository(pg, parameterized)
  -> responseHandler { success, message, data, pagination } | errorMiddleware { success:false, message, errors }
```

Row-level scope: every list or aggregate repository takes a `scope` object and adds `WHERE zone_id = ANY($n)` / `ward_id = ANY` / `agency_id = $n`. Super Admin gets an unrestricted scope.

### b.3 Background jobs (in-process, with a single-runner guard)

| Job | Schedule | Does |
|---|---|---|
| `gpsPollingJob` | every `GPS_POLL_INTERVAL_SECONDS` | adapter.fetchLatest() → normalize/validate → batch `INSERT ... ON CONFLICT (vehicle_id, recorded_at) DO NOTHING` → upsert `vehicle_latest_locations` (only if newer `recorded_at`) → enqueue new gps_location ids → emit `vehicle:location`. Logs each run to `gps_poll_runs`. |
| `pidVisitProcessingJob` | right after each poll, plus a catch-up every 5 min | processes unprocessed `gps_locations` (`processed_at IS NULL`) ordered by vehicle, recorded_at. Detection engine → `pid_visit_events` + `pid_daily_status` in one tx → emit `pid:status`. Late or out-of-order points are handled because processing is keyed on `recorded_at`, not arrival order. |
| `dailyCoverageJob` | 00:30 IST, plus on demand | finalises the previous operational date: assigned PIDs with no event become `NOT_VISITED`, or `GPS_DATA_UNAVAILABLE` when the vehicle had fewer than N valid points in the shift window. Writes snapshot counters. |

Each job takes `pg_try_advisory_lock(<job-key>)`, so two app instances can't run the same job twice. Every step is idempotent: unique constraints plus `ON CONFLICT`.

### b.4 Socket.IO

- The handshake carries the JWT, which the server verifies. The socket joins rooms `zone:<id>`, `ward:<id>`, `agency:<id>`, or `all` (super admin) based on user scope.
- Events: `vehicle:location` {vehicle_id, lat, lng, speed, ignition, recorded_at}, `pid:status` {operational_date, route_assignment_id, pid_id, visit_status, first/last_visit_at}, `dashboard:invalidate` {operational_date}.
- The client reconnects automatically and refetches REST snapshots after reconnecting. No page reloads.

---

## c. ER diagram

```mermaid
erDiagram
  roles ||--o{ users : has
  zones ||--o{ users : scopes
  wards ||--o{ users : scopes
  agencies ||--o{ users : scopes
  zones ||--o{ wards : contains
  zones ||--o{ vehicles : ""
  wards ||--o{ vehicles : ""
  agencies ||--o{ vehicles : owns
  routes ||--o{ vehicles : "default route"
  zones ||--o{ pids : ""
  wards ||--o{ pids : ""
  zones ||--o{ routes : ""
  wards ||--o{ routes : ""
  agencies ||--o{ routes : ""
  vehicles ||--o{ routes : "default vehicle"
  routes ||--o{ route_pids : "master list"
  pids ||--o{ route_pids : ""
  routes ||--o{ route_assignments : "date-wise"
  vehicles ||--o{ route_assignments : ""
  users ||--o{ route_assignments : assigned_by
  route_assignments ||--o{ route_assignment_pids : "snapshot"
  pids ||--o{ route_assignment_pids : ""
  vehicles ||--o{ gps_locations : ""
  vehicles ||--|| vehicle_latest_locations : ""
  gps_locations ||--o| vehicle_latest_locations : ""
  route_assignments ||--o{ pid_visit_events : ""
  pids ||--o{ pid_visit_events : ""
  vehicles ||--o{ pid_visit_events : ""
  gps_locations ||--o{ pid_visit_events : evidence
  route_assignments ||--o{ pid_daily_status : ""
  pids ||--o{ pid_daily_status : ""
  vehicles ||--o{ pid_daily_status : ""
  pid_visit_events ||--o{ pid_daily_status : "best event"
  users ||--o{ activity_logs : ""
  users ||--o{ system_settings : updated_by
  gps_poll_runs }o--|| system_settings : ""

  roles { smallint id PK; text role_key UK; text role_name; jsonb permissions }
  users { bigint id PK; text email UK; text password_hash; smallint role_id FK; int zone_id FK; int ward_id FK; int agency_id FK; text status }
  zones { int id PK; text zone_code UK; text zone_name; text status }
  wards { int id PK; int zone_id FK; text ward_number; text ward_name; text status }
  agencies { int id PK; text agency_name UK; text contact_person; text mobile; text status }
  vehicles { int id PK; text vehicle_number UK; text gps_device_id UK; text gps_provider; int agency_id FK; int zone_id FK; int ward_id FK; int default_route_id FK; text status }
  pids { bigint id PK; text pid_number UK; numeric latitude; numeric longitude; int zone_id FK; int ward_id FK; text coord_status; text status }
  routes { int id PK; text route_code UK; text route_name; int zone_id FK; int ward_id FK; int agency_id FK; int default_vehicle_id FK; jsonb route_geometry; text status }
  route_pids { int route_id PK,FK; bigint pid_id PK,FK; int sequence_no }
  route_assignments { bigint id PK; int route_id FK; int vehicle_id FK; date operational_date; timestamptz shift_start; timestamptz shift_end; text status }
  route_assignment_pids { bigint id PK; bigint route_assignment_id FK; bigint pid_id FK; numeric pid_latitude; numeric pid_longitude }
  gps_locations { bigint id PK; int vehicle_id FK; text device_id; numeric latitude; numeric longitude; numeric speed; boolean ignition; timestamptz recorded_at; timestamptz processed_at }
  vehicle_latest_locations { int vehicle_id PK,FK; bigint gps_location_id FK; numeric latitude; numeric longitude; timestamptz recorded_at }
  pid_visit_events { bigint id PK; bigint route_assignment_id FK; bigint pid_id FK; int vehicle_id FK; bigint gps_location_id FK; numeric distance_meters; timestamptz detected_at; text evidence_status }
  pid_daily_status { bigint id PK; date operational_date; bigint route_assignment_id FK; bigint pid_id FK; int vehicle_id FK; text visit_status; timestamptz first_visit_at; timestamptz last_visit_at; int detection_count }
  system_settings { int id PK; text setting_key UK; jsonb setting_value; text description }
  activity_logs { bigint id PK; bigint user_id FK; text action; text module; text reference_id; jsonb details }
  gps_poll_runs { bigint id PK; text provider; timestamptz started_at; text outcome; int records_received; int records_saved; text error_message }
```

---

## d. PostgreSQL DDL draft (`migrations/0001_init.sql`)

Conventions:
- Enums are `TEXT` + `CHECK`, not `CREATE TYPE`, so adding a value is a simple constraint swap.
- `updated_at` is maintained by one trigger function.
- Coordinates are `NUMERIC(10,7)`, about 1 cm precision.

```sql
BEGIN;

-- ---------- helpers ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- ---------- RBAC ----------
CREATE TABLE roles (
  id           SMALLSERIAL PRIMARY KEY,
  role_key     TEXT NOT NULL UNIQUE
               CHECK (role_key IN ('SUPER_ADMIN','DEPARTMENT_ADMIN','ZONE_ADMIN','WARD_SUPERVISOR','AGENCY_USER')),
  role_name    TEXT NOT NULL,
  permissions  JSONB NOT NULL DEFAULT '[]'::jsonb,   -- e.g. ["pids:read","pids:write","reports:export"]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- master data ----------
CREATE TABLE zones (
  id          SERIAL PRIMARY KEY,
  zone_code   TEXT NOT NULL UNIQUE,
  zone_name   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wards (
  id           SERIAL PRIMARY KEY,
  zone_id      INT  NOT NULL REFERENCES zones(id) ON DELETE RESTRICT,
  ward_number  TEXT NOT NULL,
  ward_name    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (zone_id, ward_number)
);
CREATE INDEX idx_wards_zone ON wards(zone_id);

CREATE TABLE agencies (
  id              SERIAL PRIMARY KEY,
  agency_name     TEXT NOT NULL UNIQUE,
  contact_person  TEXT,
  mobile          TEXT CHECK (mobile IS NULL OR mobile ~ '^[0-9+\- ]{7,15}$'),
  address         TEXT,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role_id        SMALLINT NOT NULL REFERENCES roles(id),
  zone_id        INT REFERENCES zones(id),
  ward_id        INT REFERENCES wards(id),
  agency_id      INT REFERENCES agencies(id),
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','LOCKED')),
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_users_email_ci ON users (lower(email));
CREATE INDEX idx_users_role ON users(role_id);
-- Scope requirements per role (zone admin needs zone_id, etc.) are enforced in the service layer
-- because role_id -> role_key needs a lookup; documented in Phase 1.

CREATE TABLE routes (
  id                  SERIAL PRIMARY KEY,
  route_code          TEXT NOT NULL UNIQUE,            -- e.g. ROUTE001
  route_name          TEXT NOT NULL,
  zone_id             INT NOT NULL REFERENCES zones(id),
  ward_id             INT NOT NULL REFERENCES wards(id),
  agency_id           INT REFERENCES agencies(id),
  default_vehicle_id  INT,                              -- FK added after vehicles
  start_latitude      NUMERIC(10,7) CHECK (start_latitude  BETWEEN -90  AND 90),
  start_longitude     NUMERIC(10,7) CHECK (start_longitude BETWEEN -180 AND 180),
  end_latitude        NUMERIC(10,7) CHECK (end_latitude    BETWEEN -90  AND 90),
  end_longitude       NUMERIC(10,7) CHECK (end_longitude   BETWEEN -180 AND 180),
  route_geometry      JSONB,                            -- GeoJSON LineString; PostGIS column later (D2)
  status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_routes_zone_ward ON routes(zone_id, ward_id);
CREATE INDEX idx_routes_agency ON routes(agency_id);

CREATE TABLE vehicles (
  id                SERIAL PRIMARY KEY,
  vehicle_number    TEXT NOT NULL UNIQUE,              -- normalised upper-case, no spaces
  vehicle_type      TEXT NOT NULL,
  gps_device_id     TEXT UNIQUE,                        -- NULL allowed until mapped
  gps_provider      TEXT,
  agency_id         INT REFERENCES agencies(id),
  zone_id           INT REFERENCES zones(id),
  ward_id           INT REFERENCES wards(id),
  default_route_id  INT REFERENCES routes(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','MAINTENANCE')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vehicles_agency ON vehicles(agency_id);
CREATE INDEX idx_vehicles_zone_ward ON vehicles(zone_id, ward_id);

ALTER TABLE routes ADD CONSTRAINT fk_routes_default_vehicle
  FOREIGN KEY (default_vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL;

CREATE TABLE pids (
  id            BIGSERIAL PRIMARY KEY,
  pid_number    TEXT NOT NULL UNIQUE,
  owner_name    TEXT,
  mobile        TEXT,
  address       TEXT,
  zone_id       INT NOT NULL REFERENCES zones(id),
  ward_id       INT NOT NULL REFERENCES wards(id),
  latitude      NUMERIC(10,7) CHECK (latitude  BETWEEN -90  AND 90),
  longitude     NUMERIC(10,7) CHECK (longitude BETWEEN -180 AND 180),
  coord_status  TEXT NOT NULL DEFAULT 'MISSING'
                CHECK (coord_status IN ('MISSING','IMPORTED','MANUALLY_CORRECTED','VERIFIED')),
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),                 -- both or neither
  CHECK (coord_status <> 'MISSING' OR latitude IS NULL)
);
CREATE INDEX idx_pids_ward ON pids(ward_id);
CREATE INDEX idx_pids_zone ON pids(zone_id);
CREATE INDEX idx_pids_lat_lng ON pids(latitude, longitude) WHERE latitude IS NOT NULL;   -- bbox prefilter
CREATE INDEX idx_pids_missing_coords ON pids(id) WHERE latitude IS NULL;

-- Master route <-> PID mapping (editable). A PID MAY be on several routes (edge case §22.6).
CREATE TABLE route_pids (
  route_id     INT    NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  pid_id       BIGINT NOT NULL REFERENCES pids(id)   ON DELETE RESTRICT,
  sequence_no  INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (route_id, pid_id)
);
CREATE INDEX idx_route_pids_pid ON route_pids(pid_id);

-- ---------- daily assignments ----------
CREATE TABLE route_assignments (
  id                BIGSERIAL PRIMARY KEY,
  route_id          INT  NOT NULL REFERENCES routes(id),
  vehicle_id        INT  NOT NULL REFERENCES vehicles(id),
  agency_id         INT  REFERENCES agencies(id),       -- snapshot of agency on that day
  operational_date  DATE NOT NULL,
  shift_start       TIMESTAMPTZ,                         -- optional window; NULL = whole operational day
  shift_end         TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'PLANNED'
                    CHECK (status IN ('PLANNED','ACTIVE','COMPLETED','CANCELLED')),
  assigned_by       BIGINT REFERENCES users(id),
  -- snapshot counters (filled by jobs; source of truth stays pid_daily_status)
  assigned_pid_count INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (route_id, vehicle_id, operational_date),
  CHECK (shift_end IS NULL OR shift_start IS NULL OR shift_end > shift_start)
);
CREATE INDEX idx_ra_date_vehicle ON route_assignments(operational_date, vehicle_id);
CREATE INDEX idx_ra_route_date ON route_assignments(route_id, operational_date);

-- Immutable daily snapshot of PIDs (+ coordinates at time of assignment) so history never shifts.
CREATE TABLE route_assignment_pids (
  id                   BIGSERIAL PRIMARY KEY,
  route_assignment_id  BIGINT NOT NULL REFERENCES route_assignments(id) ON DELETE CASCADE,
  pid_id               BIGINT NOT NULL REFERENCES pids(id),
  pid_latitude         NUMERIC(10,7) CHECK (pid_latitude  BETWEEN -90  AND 90),
  pid_longitude        NUMERIC(10,7) CHECK (pid_longitude BETWEEN -180 AND 180),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (route_assignment_id, pid_id)
);
CREATE INDEX idx_rap_pid ON route_assignment_pids(pid_id);
CREATE INDEX idx_rap_ra_lat_lng ON route_assignment_pids(route_assignment_id, pid_latitude, pid_longitude);

-- ---------- GPS ----------
CREATE TABLE gps_locations (
  id            BIGSERIAL PRIMARY KEY,
  vehicle_id    INT NOT NULL REFERENCES vehicles(id),
  device_id     TEXT NOT NULL,
  latitude      NUMERIC(10,7) NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
  longitude     NUMERIC(10,7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  speed         NUMERIC(6,2) CHECK (speed IS NULL OR speed >= 0),     -- km/h
  heading       NUMERIC(5,2) CHECK (heading IS NULL OR heading BETWEEN 0 AND 360),
  ignition      BOOLEAN,
  gps_accuracy  NUMERIC(8,2) CHECK (gps_accuracy IS NULL OR gps_accuracy >= 0),  -- metres / HDOP
  provider_status TEXT,
  recorded_at   TIMESTAMPTZ NOT NULL,                  -- device time (drives operational date)
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,                           -- set by detection job (idempotency)
  raw_payload   JSONB,                                 -- optional, for debugging provider issues
  UNIQUE (vehicle_id, recorded_at)                     -- dedupe; also serves the (vehicle_id, recorded_at) index
);
CREATE INDEX idx_gps_unprocessed ON gps_locations(vehicle_id, recorded_at) WHERE processed_at IS NULL;
CREATE INDEX idx_gps_received ON gps_locations(received_at);
-- Phase 7: convert to monthly range partitions on recorded_at (unique key already includes it) + archival.

CREATE TABLE vehicle_latest_locations (
  vehicle_id       INT PRIMARY KEY REFERENCES vehicles(id) ON DELETE CASCADE,
  gps_location_id  BIGINT REFERENCES gps_locations(id) ON DELETE SET NULL,
  latitude         NUMERIC(10,7) NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
  longitude        NUMERIC(10,7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  speed            NUMERIC(6,2),
  ignition         BOOLEAN,
  provider_status  TEXT,
  recorded_at      TIMESTAMPTZ NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Upsert rule: ON CONFLICT (vehicle_id) DO UPDATE ... WHERE EXCLUDED.recorded_at > vehicle_latest_locations.recorded_at

CREATE TABLE gps_poll_runs (                           -- backs GET /api/gps/provider-status
  id                BIGSERIAL PRIMARY KEY,
  provider          TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  outcome           TEXT NOT NULL DEFAULT 'RUNNING' CHECK (outcome IN ('RUNNING','SUCCESS','PARTIAL','FAILED')),
  records_received  INT NOT NULL DEFAULT 0,
  records_saved     INT NOT NULL DEFAULT 0,
  records_rejected  INT NOT NULL DEFAULT 0,
  error_message     TEXT
);
CREATE INDEX idx_gps_poll_runs_started ON gps_poll_runs(started_at DESC);

-- ---------- visit detection ----------
CREATE TABLE pid_visit_events (
  id                   BIGSERIAL PRIMARY KEY,
  route_assignment_id  BIGINT NOT NULL REFERENCES route_assignments(id),
  pid_id               BIGINT NOT NULL REFERENCES pids(id),
  vehicle_id           INT    NOT NULL REFERENCES vehicles(id),
  gps_location_id      BIGINT NOT NULL REFERENCES gps_locations(id),
  distance_meters      NUMERIC(8,2) NOT NULL CHECK (distance_meters >= 0),
  speed_at_detection   NUMERIC(6,2),
  detected_at          TIMESTAMPTZ NOT NULL,             -- = gps recorded_at
  evidence_status      TEXT NOT NULL
                       CHECK (evidence_status IN ('PROXIMITY_POINT','CONSECUTIVE_CONFIRMED','REJECTED_SPEED','REJECTED_STALE')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (route_assignment_id, pid_id, gps_location_id)  -- re-processing a point never duplicates
);
CREATE INDEX idx_pve_pid_detected ON pid_visit_events(pid_id, detected_at);
CREATE INDEX idx_pve_ra ON pid_visit_events(route_assignment_id);

CREATE TABLE pid_daily_status (
  id                    BIGSERIAL PRIMARY KEY,
  operational_date      DATE   NOT NULL,
  route_assignment_id   BIGINT NOT NULL REFERENCES route_assignments(id) ON DELETE CASCADE,
  pid_id                BIGINT NOT NULL REFERENCES pids(id),
  vehicle_id            INT    NOT NULL REFERENCES vehicles(id),
  visit_status          TEXT   NOT NULL DEFAULT 'NOT_VISITED'
                        CHECK (visit_status IN ('GPS_VISIT_CONFIRMED','GPS_VISIT_CANDIDATE','NOT_VISITED',
                                                'GPS_DATA_UNAVAILABLE','UNASSIGNED_PID')),
  first_visit_at        TIMESTAMPTZ,
  last_visit_at         TIMESTAMPTZ,
  detection_count       INT NOT NULL DEFAULT 0 CHECK (detection_count >= 0),
  min_distance_meters   NUMERIC(8,2),
  best_event_id         BIGINT REFERENCES pid_visit_events(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operational_date, route_assignment_id, pid_id),
  CHECK (last_visit_at IS NULL OR first_visit_at IS NULL OR last_visit_at >= first_visit_at)
);
CREATE INDEX idx_pds_date_status ON pid_daily_status(operational_date, visit_status);
CREATE INDEX idx_pds_pid_date ON pid_daily_status(pid_id, operational_date);
CREATE INDEX idx_pds_vehicle_date ON pid_daily_status(vehicle_id, operational_date);
-- Rows are pre-created (NOT_VISITED) when an assignment is created, so missed-PID reports are simple selects.
-- UNASSIGNED_PID is normally *derived* at query time (active PIDs with no assignment that date); the value
-- is allowed in the CHECK for spec parity / exported report rows.

-- ---------- config & audit ----------
CREATE TABLE system_settings (
  id             SERIAL PRIMARY KEY,
  setting_key    TEXT NOT NULL UNIQUE,
  setting_value  JSONB NOT NULL,
  description    TEXT,
  updated_by     BIGINT REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE activity_logs (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,          -- CREATE / UPDATE / DELETE / LOGIN / LOGIN_FAILED / EXPORT / IMPORT
  module        TEXT NOT NULL,
  reference_id  TEXT,
  details       JSONB,
  ip_address    INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_logs_created ON activity_logs(created_at DESC);
CREATE INDEX idx_activity_logs_user ON activity_logs(user_id, created_at DESC);

-- ---------- updated_at triggers ----------
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['roles','zones','wards','agencies','users','routes','vehicles','pids',
                           'route_assignments','pid_daily_status','system_settings'] LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

COMMIT;
```

**Seed (`0002_seed.sql`):** five roles with permission arrays, plus the `system_settings` defaults from §8.2:
`detection.radius_meters=30`, `detection.max_gps_age_seconds=300`, `detection.min_speed_kmh=null`, `detection.max_speed_kmh=60`, `detection.consecutive_points=2`, `detection.duplicate_prevention=true`, `detection.enabled=true`, `detection.require_dwell_seconds=null`, `gps.poll_interval_seconds=60`, `gps.min_points_for_data_available=5`.

**Tables added beyond §15, and why:**
- `route_pids`: the master route ↔ PID list, editable. Kept separate from the daily snapshot `route_assignment_pids`, which is copied from it at assignment time. The snapshot also copies the PID coordinates, so a later coordinate fix doesn't rewrite history (§9, §27.13).
- `gps_poll_runs`: provider health and audit for `/api/gps/provider-status`, and for monitoring API limits (§21).
- **No `vehicle_route_history`.** `route_assignments`, keyed by date, already is the assignment history ("maintain history rather than overwriting", §6). `vehicles.default_route_id` is only a default used to pre-fill new daily assignments. A second history table would duplicate data and could drift out of sync. If the guide wants an audit of default-route changes, `activity_logs.details` covers it.

**Detection engine sketch (Phase 4, documented now so the schema fits):**
For each unprocessed point P of vehicle V:
1. `op_date = (P.recorded_at AT TIME ZONE 'Asia/Kolkata')::date`.
2. Find active assignment(s) of V on op_date, where `shift_start/end` contains P.recorded_at when set.
3. Bounding-box query on `route_assignment_pids` (lat ± r/111320, lng ± r/(111320·cos lat)).
4. Haversine distance ≤ radius.
5. Reject P if it is stale (`received_at - recorded_at > max_age` for live mode), outside the speed range, or invalid.
6. Insert into `pid_visit_events` with ON CONFLICT DO NOTHING.
7. Upsert `pid_daily_status`. It becomes CANDIDATE on the first qualifying point, and CONFIRMED when ≥ `consecutive_points` qualifying points come from consecutive GPS records of V (no non-qualifying point between them, by recorded_at order).
8. Mark P processed.

Steps 6–8 run in one transaction.

---

## e. Development milestones

| Phase | Deliverables | Done when |
|---|---|---|
| 1 Foundation | be scaffold (express, env validation, pino, error/response helpers), `migrate.js` + 0001/0002, auth (login/profile/logout, bcrypt, JWT, rate-limit), RBAC + scope middleware, CRUD for zones/wards/agencies/vehicles/users, activity logging; fe scaffold (Vite + Tailwind + router + layout + login + 4 master pages) | migrations run on Neon; vitest+supertest green; login works end-to-end in browser |
| 2 PIDs & routes | PID CRUD, CSV/XLSX import (validation report: duplicates, invalid/missing coords), map coordinate correction, PID map with filters; route CRUD + route_pids + geometry; daily route assignments with PID snapshot + pre-created pid_daily_status | import of a 10k-row sample with error report; snapshot unaffected by later route edits (test) |
| 3 GPS | adapter interface + simulator adapter, normalization/validation, polling job w/ advisory lock, gps_locations dedupe, latest-location upsert, poll-run log, provider-status / live-vehicles / vehicle-history APIs | simulator drives realistic tracks; out-of-order + duplicate points tested |
| 4 Detection | haversine + bbox util, engine, consecutive-point confirmation, idempotency, daily finalisation job; optional PostGIS column + GIST | unit tests for all §22 edge cases; re-running job yields identical results |
| 5 Monitoring UI | Socket.IO rooms, live tracking map + side panel, PID coverage map with legend/toggles, route comparison, dashboard cards + Recharts | live markers move with simulator, no page reloads |
| 6 Reports | 6 reports with filters/pagination + Excel (exceljs) + PDF (pdfkit) export | exports match on-screen numbers |
| 7 Hardening | perf test with ~1M gps rows / 200k PIDs, partitioning plan, security review, deployment docs (Ubuntu, pm2/systemd, nginx, HTTPS), env var docs | checklist signed off |

---

## f. GPS provider details needed from the client

1. Provider name, API documentation, and sandbox/test credentials.
2. **Auth method**: API key header, Basic auth, OAuth2 client-credentials, or session token + login endpoint. Token lifetime and refresh flow.
3. **Base URL(s)** for production and sandbox. Any IP-whitelisting requirement (our server's egress IP).
4. **Endpoints**: list devices/vehicles; latest location for all devices (bulk, ideally); history for a device between `from`/`to`; device status (online/offline).
5. **Sample responses** (real JSON or XML) for each endpoint, including an offline device and an error response.
6. **Field mapping**: device ID field (IMEI? provider vehicle ID?), vehicle registration field, lat/lng field names and format (decimal degrees vs NMEA), speed unit (km/h, knots, m/s), ignition/ACC field, heading, accuracy/HDOP/satellite count, provider status codes.
7. **Timestamps**: field name, format (ISO / epoch s / epoch ms), and **timezone** (UTC or IST, with or without offset). Is it device fix time or server receive time?
8. **Rate limits**: requests/min, max devices per call, pagination scheme, and behaviour when exceeded (429? ban?).
9. **Data frequency**: how often devices report while moving, while idle, and with ignition off.
10. Is **push/webhook** delivery supported (better than polling)? If so, the payload format and signature verification method.
11. History limits: max time range per request, and data retention period.
12. Do multiple GPS providers or vendors exist across agencies? This decides whether the `gps_provider` column needs per-vehicle adapter routing.
13. Error semantics and SLA/uptime. Who to contact when the API is down.
