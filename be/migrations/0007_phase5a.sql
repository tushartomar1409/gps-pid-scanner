-- 0007_phase5a.sql — monitoring backend (GUIDE #8). ADDITIVE ONLY.

INSERT INTO system_settings (setting_key, setting_value, description) VALUES
  ('detection.deviation_threshold_m', '50', 'Route comparison: a GPS point further than this from the assigned route line is off-route'),
  ('detection.distance_min_segment_m', '5', 'GPS route distance: ignore segments shorter than this while the vehicle is (near) stationary (< 3 km/h) — jitter')
ON CONFLICT (setting_key) DO NOTHING;

-- Dashboard hourly-activity / daily-trend scan GPS points by time across ALL vehicles; the existing
-- (vehicle_id, recorded_at) unique index only serves per-vehicle ranges.
CREATE INDEX idx_gps_recorded_at ON gps_locations (recorded_at);
