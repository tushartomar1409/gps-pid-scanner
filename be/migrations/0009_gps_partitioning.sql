-- 0009_gps_partitioning.sql — GPS data lifecycle (GUIDE #11 A, workflow-docs/gps-data-lifecycle.md).
-- gps_locations becomes a monthly RANGE-partitioned table on recorded_at (IST months) with a DEFAULT
-- partition; visit evidence becomes self-contained so whole partitions can be dropped by retention.
--
-- DESTRUCTIVE (the table is recreated). Authorised by GUIDE #11 A3 ONLY for empty tables: the guard
-- below aborts the whole migration (it runs in one transaction) if any GPS point or visit event exists.
DO $$
DECLARE g bigint; e bigint;
BEGIN
  SELECT count(*) INTO g FROM gps_locations;
  SELECT count(*) INTO e FROM pid_visit_events;
  IF g > 0 OR e > 0 THEN
    RAISE EXCEPTION '0009_gps_partitioning needs EMPTY gps_locations and pid_visit_events (found % GPS points, % visit events). Purge first (npm run gps:purge-sim -- --confirm) and ask the guide before applying.', g, e;
  END IF;
END $$;

-- 1. References to a partitioned table's id alone cannot be foreign keys: keep plain bigint references.
ALTER TABLE pid_visit_events DROP CONSTRAINT IF EXISTS pid_visit_events_gps_location_id_fkey;
ALTER TABLE vehicle_latest_locations DROP CONSTRAINT IF EXISTS vehicle_latest_locations_gps_location_id_fkey;
COMMENT ON COLUMN pid_visit_events.gps_location_id IS
  'Id of the GPS point (no FK: gps_locations is partitioned and old partitions are dropped by retention). Evidence is self-contained in the gps_* columns.';

-- 2. Self-contained evidence: the point's time/position/speed travel with the event (both tables are empty,
--    so NOT NULL is safe). For TRACK_SEGMENT these describe the LATER point of the segment.
ALTER TABLE pid_visit_events
  ADD COLUMN gps_recorded_at TIMESTAMPTZ  NOT NULL,
  ADD COLUMN gps_latitude    NUMERIC(10,7) NOT NULL CHECK (gps_latitude  BETWEEN -90  AND 90),
  ADD COLUMN gps_longitude   NUMERIC(10,7) NOT NULL CHECK (gps_longitude BETWEEN -180 AND 180),
  ADD COLUMN gps_speed       NUMERIC(6,2);
ALTER TABLE vehicle_latest_locations ADD COLUMN heading NUMERIC(5,2) CHECK (heading IS NULL OR heading BETWEEN 0 AND 360);

-- 3. Recreate gps_locations partitioned. The sequence is created explicitly so ids stay unique across partitions.
DROP TABLE gps_locations;
CREATE SEQUENCE gps_locations_id_seq AS bigint;
CREATE TABLE gps_locations (
  id              BIGINT NOT NULL DEFAULT nextval('gps_locations_id_seq'),
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
  provider        TEXT,
  PRIMARY KEY (id, recorded_at),
  UNIQUE (vehicle_id, recorded_at)
) PARTITION BY RANGE (recorded_at);
ALTER SEQUENCE gps_locations_id_seq OWNED BY gps_locations.id;
-- Same secondary indexes as before (now per partition).
CREATE INDEX idx_gps_unprocessed ON gps_locations (vehicle_id, recorded_at) WHERE processed_at IS NULL;
CREATE INDEX idx_gps_received ON gps_locations (received_at);
CREATE INDEX idx_gps_recorded_at ON gps_locations (recorded_at);
CREATE INDEX idx_gps_locations_provider ON gps_locations (provider) WHERE provider IS NOT NULL;
COMMENT ON TABLE gps_locations IS 'Raw GPS points, monthly partitions gps_locations_pYYYY_MM on recorded_at (IST months). Retention drops whole partitions (gps.retention_days).';

-- Rows outside every monthly partition land here; the lifecycle job alerts when it is not empty.
CREATE TABLE gps_locations_default PARTITION OF gps_locations DEFAULT;

-- 4. Partition helpers. Names come from format('%I', ...) of dates only: no caller-supplied identifiers.
-- Monthly bounds are IST month starts: [YYYY-MM-01 00:00 IST, next month 00:00 IST).
CREATE FUNCTION gps_partition_name(p_month date) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT 'gps_locations_p' || to_char(p_month, 'YYYY_MM') $$;

/** Creates the monthly partitions for p_months months starting at the month of p_from. Idempotent.
 *  Returns the names it created. Fails (by design) if DEFAULT already holds rows for that month. */
CREATE FUNCTION gps_ensure_partitions(p_from date, p_months int, p_tz text DEFAULT 'Asia/Kolkata')
RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE m date; nm text; parent text := quote_ident(current_schema()) || '.gps_locations';
BEGIN
  FOR i IN 0 .. p_months - 1 LOOP
    m := (date_trunc('month', p_from) + make_interval(months => i))::date;
    nm := gps_partition_name(m);
    IF to_regclass(quote_ident(current_schema()) || '.' || quote_ident(nm)) IS NULL THEN
      EXECUTE format('CREATE TABLE %I.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        current_schema(), nm, parent,
        (m::timestamp AT TIME ZONE p_tz), ((m + interval '1 month')::timestamp AT TIME ZONE p_tz));
      RETURN NEXT nm;
    END IF;
  END LOOP;
END $$;

/** Every partition with its bounds and estimated rows (reltuples; -1 = never analyzed -> NULL). */
CREATE FUNCTION gps_partitions()
RETURNS TABLE (name text, is_default boolean, range_from timestamptz, range_to timestamptz, est_rows bigint, total_bytes bigint)
LANGUAGE sql STABLE AS $$
  SELECT c.relname::text,
         pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT',
         (regexp_match(pg_get_expr(c.relpartbound, c.oid), $r$FROM \('([^']+)'\)$r$))[1]::timestamptz,
         (regexp_match(pg_get_expr(c.relpartbound, c.oid), $r$TO \('([^']+)'\)$r$))[1]::timestamptz,
         NULLIF(c.reltuples, -1)::bigint,
         pg_total_relation_size(c.oid)
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
   WHERE i.inhparent = (quote_ident(current_schema()) || '.gps_locations')::regclass
   ORDER BY 3 NULLS LAST, 1
$$;

/** Drops (detach + drop) every monthly partition whose WHOLE range ends at or before p_cutoff.
 *  Never touches DEFAULT. Returns the dropped names. Constant-time per partition (no row DELETE). */
CREATE FUNCTION gps_drop_partitions_before(p_cutoff timestamptz)
RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.name FROM gps_partitions() p WHERE NOT p.is_default AND p.range_to <= p_cutoff ORDER BY p.range_from LOOP
    EXECUTE format('ALTER TABLE %I.gps_locations DETACH PARTITION %I.%I', current_schema(), current_schema(), r.name);
    EXECUTE format('DROP TABLE %I.%I', current_schema(), r.name);
    RETURN NEXT r.name;
  END LOOP;
END $$;

-- 5. Initial partitions: previous month (late/back-dated points around a month boundary) .. 2 months ahead.
SELECT gps_ensure_partitions(((now() AT TIME ZONE 'Asia/Kolkata')::date - interval '1 month')::date, 4);

-- 6. Retention setting (days of RAW GPS kept; visit evidence is kept independently).
INSERT INTO system_settings (setting_key, setting_value, description) VALUES
  ('gps.retention_days', '180', 'Days of raw GPS points kept. Whole monthly partitions older than this are dropped; visit evidence keeps its own copy.')
ON CONFLICT (setting_key) DO NOTHING;
