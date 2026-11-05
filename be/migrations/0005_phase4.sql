-- 0005_phase4.sql — PID visit detection (GUIDE #7). ADDITIVE ONLY: function, columns, settings, index.

-- SQL twin of src/utils/haversine.js (same radius, same formula; parity-tested to 0.01 m).
CREATE OR REPLACE FUNCTION haversine_m(lat1 double precision, lng1 double precision,
                                       lat2 double precision, lng2 double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 2 * 6371008.8 * asin(least(1, sqrt(
           power(sin(radians(lat2 - lat1) / 2), 2)
         + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))
$$;

-- Evidence quality (flow.txt §8.5): one GPS point within radius of several PIDs (dense streets).
ALTER TABLE pid_visit_events
  ADD COLUMN ambiguous BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN pids_in_radius INT NOT NULL DEFAULT 1 CHECK (pids_in_radius >= 1);

-- Daily status: when it first became CONFIRMED, and whether any supporting event was ambiguous.
ALTER TABLE pid_daily_status
  ADD COLUMN confirmed_at TIMESTAMPTZ,
  ADD COLUMN ambiguous BOOLEAN NOT NULL DEFAULT false;

-- End-of-window finalization (dailyCoverageJob).
ALTER TABLE route_assignments ADD COLUMN finalized_at TIMESTAMPTZ;
-- Finalizer scan: open assignments only.
CREATE INDEX idx_ra_open ON route_assignments (operational_date) WHERE finalized_at IS NULL AND status IN ('PLANNED', 'ACTIVE');

-- Detection settings (defaults; editable via PUT /api/settings/:key).
INSERT INTO system_settings (setting_key, setting_value, description) VALUES
  ('detection.confirmation_mode',   '"consecutive_points"', 'consecutive_points | min_events | dwell'),
  ('detection.confirmation_window_s','300',  'min_events mode: N valid events within this many seconds'),
  ('detection.min_dwell_seconds',   '60',    'dwell mode: adjacent in-radius points spanning at least this long'),
  ('detection.late_points_policy',  '"evidence_only"', 'evidence_only: stale points are evidence but never confirm; accept: treat as normal'),
  ('detection.finalize_grace_minutes','120', 'Finalize an assignment this long after its window closes')
ON CONFLICT (setting_key) DO NOTHING;
