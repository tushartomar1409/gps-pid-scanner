-- 0001_init.sql — core schema (Phase 0 proposal + GUIDE #2 corrections C1–C4).
-- Runner (scripts/migrate.js) wraps each file in a transaction; do not add BEGIN/COMMIT here.

-- PostGIS: enabled now to prove it works on Neon; geography columns arrive in Phase 4 (D2).
-- Pinned to schema public so test schemas (DROP SCHEMA ... CASCADE) never take the extension with them.
CREATE EXTENSION IF NOT EXISTS postgis SCHEMA public;

-- ---------- helpers ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- ---------- RBAC ----------
CREATE TABLE roles (
  id           SMALLSERIAL PRIMARY KEY,
  role_key     TEXT NOT NULL UNIQUE
               CHECK (role_key IN ('SUPER_ADMIN','DEPARTMENT_ADMIN','ZONE_ADMIN','WARD_SUPERVISOR','AGENCY_USER')),
  role_name    TEXT NOT NULL,
  permissions  JSONB NOT NULL DEFAULT '[]'::jsonb,
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
  UNIQUE (zone_id, ward_number),
  UNIQUE (id, zone_id)                                  -- C1: target for composite (ward_id, zone_id) FKs
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
  ward_id        INT,
  agency_id      INT REFERENCES agencies(id),
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','LOCKED')),
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- C1: ward must belong to zone. MATCH SIMPLE skips the check if either column is NULL,
  -- so also forbid "ward without zone".
  CONSTRAINT fk_users_ward_zone FOREIGN KEY (ward_id, zone_id) REFERENCES wards(id, zone_id),
  CONSTRAINT chk_users_ward_needs_zone CHECK (ward_id IS NULL OR zone_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_users_email_ci ON users (lower(email));
CREATE INDEX idx_users_role ON users(role_id);
-- Role-specific scope requirements (ZONE_ADMIN needs zone_id, ...) are enforced in userService.

CREATE TABLE routes (
  id                  SERIAL PRIMARY KEY,
  route_code          TEXT NOT NULL UNIQUE,
  route_name          TEXT NOT NULL,
  zone_id             INT NOT NULL REFERENCES zones(id),
  ward_id             INT NOT NULL,
  agency_id           INT REFERENCES agencies(id),
  default_vehicle_id  INT,                              -- FK added after vehicles
  start_latitude      NUMERIC(10,7) CHECK (start_latitude  BETWEEN -90  AND 90),
  start_longitude     NUMERIC(10,7) CHECK (start_longitude BETWEEN -180 AND 180),
  end_latitude        NUMERIC(10,7) CHECK (end_latitude    BETWEEN -90  AND 90),
  end_longitude       NUMERIC(10,7) CHECK (end_longitude   BETWEEN -180 AND 180),
  route_geometry      JSONB,                            -- GeoJSON LineString; PostGIS column in Phase 4
  status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_routes_ward_zone FOREIGN KEY (ward_id, zone_id) REFERENCES wards(id, zone_id)   -- C1
);
CREATE INDEX idx_routes_zone_ward ON routes(zone_id, ward_id);
CREATE INDEX idx_routes_agency ON routes(agency_id);

CREATE TABLE vehicles (
  id                SERIAL PRIMARY KEY,
  vehicle_number    TEXT NOT NULL UNIQUE,              -- normalised upper-case, no spaces
  vehicle_type      TEXT NOT NULL,
  gps_device_id     TEXT UNIQUE,                       -- C4: UNIQUE provides index vehicles_gps_device_id_key
  gps_provider      TEXT,
  agency_id         INT REFERENCES agencies(id),
  zone_id           INT REFERENCES zones(id),
  ward_id           INT,
  default_route_id  INT REFERENCES routes(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','MAINTENANCE')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_vehicles_ward_zone FOREIGN KEY (ward_id, zone_id) REFERENCES wards(id, zone_id),  -- C1
  CONSTRAINT chk_vehicles_ward_needs_zone CHECK (ward_id IS NULL OR zone_id IS NOT NULL)
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
  ward_id       INT NOT NULL,
  latitude      NUMERIC(10,7) CHECK (latitude  BETWEEN -90  AND 90),
  longitude     NUMERIC(10,7) CHECK (longitude BETWEEN -180 AND 180),
  coord_status  TEXT NOT NULL DEFAULT 'MISSING'
                CHECK (coord_status IN ('MISSING','IMPORTED','MANUALLY_CORRECTED','VERIFIED')),
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_pids_ward_zone FOREIGN KEY (ward_id, zone_id) REFERENCES wards(id, zone_id),   -- C1
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (coord_status <> 'MISSING' OR latitude IS NULL)
);
CREATE INDEX idx_pids_ward ON pids(ward_id);
CREATE INDEX idx_pids_zone ON pids(zone_id);
CREATE INDEX idx_pids_lat_lng ON pids(latitude, longitude) WHERE latitude IS NOT NULL;
CREATE INDEX idx_pids_missing_coords ON pids(id) WHERE latitude IS NULL;

CREATE TABLE route_pids (
  route_id     INT    NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  pid_id       BIGINT NOT NULL REFERENCES pids(id)   ON DELETE RESTRICT,
  sequence_no  INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (route_id, pid_id)
);
CREATE INDEX idx_route_pids_pid ON route_pids(pid_id);

-- ---------- daily assignments ----------
-- Service rules (Phase 2, GUIDE #2 Q1): same vehicle+date windows must not overlap (409);
-- at most one NULL-window assignment per vehicle+date.
CREATE TABLE route_assignments (
  id                 BIGSERIAL PRIMARY KEY,
  route_id           INT  NOT NULL REFERENCES routes(id),
  vehicle_id         INT  NOT NULL REFERENCES vehicles(id),
  agency_id          INT  REFERENCES agencies(id),
  operational_date   DATE NOT NULL,
  shift_start        TIMESTAMPTZ,
  shift_end          TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'PLANNED'
                     CHECK (status IN ('PLANNED','ACTIVE','COMPLETED','CANCELLED')),
  assigned_by        BIGINT REFERENCES users(id),
  assigned_pid_count INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (route_id, vehicle_id, operational_date),
  CHECK ((shift_start IS NULL) = (shift_end IS NULL)),
  CHECK (shift_end IS NULL OR shift_end > shift_start)
);
CREATE INDEX idx_ra_date_vehicle ON route_assignments(operational_date, vehicle_id);
CREATE INDEX idx_ra_route_date ON route_assignments(route_id, operational_date);

-- C3: daily snapshot. If the PID has no coordinates at snapshot time the row is still inserted with
-- NULL pid_latitude/pid_longitude, and its pid_daily_status is pre-created as GPS_DATA_UNAVAILABLE
-- (not NOT_VISITED). Logic implemented in Phase 2.
CREATE TABLE route_assignment_pids (
  id                   BIGSERIAL PRIMARY KEY,
  route_assignment_id  BIGINT NOT NULL REFERENCES route_assignments(id) ON DELETE CASCADE,
  pid_id               BIGINT NOT NULL REFERENCES pids(id),
  pid_latitude         NUMERIC(10,7) CHECK (pid_latitude  BETWEEN -90  AND 90),
  pid_longitude        NUMERIC(10,7) CHECK (pid_longitude BETWEEN -180 AND 180),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (route_assignment_id, pid_id),
  CHECK ((pid_latitude IS NULL) = (pid_longitude IS NULL))
);
CREATE INDEX idx_rap_pid ON route_assignment_pids(pid_id);
CREATE INDEX idx_rap_ra_lat_lng ON route_assignment_pids(route_assignment_id, pid_latitude, pid_longitude);

-- ---------- GPS ----------
CREATE TABLE gps_locations (
  id              BIGSERIAL PRIMARY KEY,
  vehicle_id      INT NOT NULL REFERENCES vehicles(id),
  device_id       TEXT NOT NULL,
  latitude        NUMERIC(10,7) NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
  longitude       NUMERIC(10,7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  speed           NUMERIC(6,2) CHECK (speed IS NULL OR speed >= 0),
  heading         NUMERIC(5,2) CHECK (heading IS NULL OR heading BETWEEN 0 AND 360),
  ignition        BOOLEAN,
  gps_accuracy    NUMERIC(8,2) CHECK (gps_accuracy IS NULL OR gps_accuracy >= 0),
  provider_status TEXT,
  recorded_at     TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  raw_payload     JSONB,
  UNIQUE (vehicle_id, recorded_at)
);
CREATE INDEX idx_gps_unprocessed ON gps_locations(vehicle_id, recorded_at) WHERE processed_at IS NULL;
CREATE INDEX idx_gps_received ON gps_locations(received_at);

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

CREATE TABLE gps_poll_runs (
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
  detected_at          TIMESTAMPTZ NOT NULL,
  evidence_status      TEXT NOT NULL
                       CHECK (evidence_status IN ('PROXIMITY_POINT','CONSECUTIVE_CONFIRMED','REJECTED_SPEED','REJECTED_STALE')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (route_assignment_id, pid_id, gps_location_id)
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
COMMENT ON COLUMN pid_daily_status.vehicle_id IS
  'C2: denormalised copy of route_assignments.vehicle_id, set when the row is created; never updated independently.';
COMMENT ON COLUMN pid_daily_status.visit_status IS
  'Pre-created NOT_VISITED (or GPS_DATA_UNAVAILABLE when the PID had no coordinates at snapshot, C3). UNASSIGNED_PID is normally derived at query time.';

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
  action        TEXT NOT NULL,
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
