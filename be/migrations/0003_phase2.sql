-- 0003_phase2.sql — PIDs import/map, routes, date-wise route assignments (GUIDE #4).

-- ---------- settings ----------
INSERT INTO system_settings (setting_key, setting_value, description) VALUES
  ('geo.service_area_bbox', '{"min_lat":6,"max_lat":37.5,"min_lng":68,"max_lng":97.5}',
   'Service-area bounding box (India). Used only to WARN about suspicious coordinates, never to reject.')
ON CONFLICT (setting_key) DO NOTHING;

-- ---------- permissions ----------
-- A2: AGENCY_USER may read PIDs (row scope via its routes / assignments, enforced in pidRepository).
UPDATE roles SET permissions = permissions || '["pids:read"]'::jsonb
 WHERE role_key = 'AGENCY_USER' AND NOT permissions ? 'pids:read';
-- D7: make sure zone/ward roles can read assignments (already seeded in 0002; idempotent guard).
UPDATE roles SET permissions = permissions || '["assignments:read"]'::jsonb
 WHERE role_key IN ('ZONE_ADMIN','WARD_SUPERVISOR') AND NOT permissions ? 'assignments:read';

-- ---------- route_assignments uniqueness ----------
-- The 0001 UNIQUE(route_id, vehicle_id, operational_date) also counted CANCELLED rows, so a cancelled
-- assignment could never be re-created. Replace it with a partial unique index over live rows only.
ALTER TABLE route_assignments DROP CONSTRAINT route_assignments_route_id_vehicle_id_operational_date_key;
CREATE UNIQUE INDEX uq_ra_route_vehicle_date_live
  ON route_assignments (route_id, vehicle_id, operational_date) WHERE status <> 'CANCELLED';

-- Overlap check for a vehicle's shift windows (any date, since shifts may cross midnight):
--   WHERE vehicle_id = $1 AND status <> 'CANCELLED' AND shift_start < $end AND shift_end > $start
CREATE INDEX idx_ra_vehicle_shift ON route_assignments (vehicle_id, shift_start, shift_end)
  WHERE status <> 'CANCELLED' AND shift_start IS NOT NULL;

-- Agency-scoped assignment lists and the AGENCY_USER PID-scope EXISTS via assignments.
CREATE INDEX idx_ra_agency_date ON route_assignments (agency_id, operational_date);

-- ---------- PID search ----------
-- ?search= does ILIKE '%term%' on pid_number / address; btree cannot serve a leading wildcard.
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;
CREATE INDEX idx_pids_pid_number_trgm ON pids USING gin (pid_number public.gin_trgm_ops);
CREATE INDEX idx_pids_address_trgm ON pids USING gin (address public.gin_trgm_ops);

-- ---------- coverage counts ----------
-- covered_pid_count per assignment: count(*) FILTER (visit_status = ...) WHERE route_assignment_id = $1.
-- The 0001 unique index leads with operational_date; this one serves per-assignment lookups directly.
CREATE INDEX idx_pds_ra_status ON pid_daily_status (route_assignment_id, visit_status);
