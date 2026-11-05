-- 0004_phase3.sql — GPS integration (GUIDE #6).

-- Vehicles whose latest GPS point is older than this are OFFLINE on the live view.
INSERT INTO system_settings (setting_key, setting_value, description) VALUES
  ('gps.offline_after_seconds', '300', 'A vehicle is OFFLINE when its latest GPS point is older than this many seconds')
ON CONFLICT (setting_key) DO NOTHING;

-- Poll run bookkeeping: per-reason reject counts and what triggered the run.
ALTER TABLE gps_poll_runs
  ADD COLUMN rejected_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN trigger TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (trigger IN ('SCHEDULED','MANUAL'));
CREATE INDEX idx_gps_poll_runs_provider_started ON gps_poll_runs (provider, started_at DESC);

-- Which provider adapter produced a point. Lets `npm run gps:purge-sim` remove simulator demo data
-- precisely, and keeps provenance if several providers are ever used side by side.
ALTER TABLE gps_locations ADD COLUMN provider TEXT;
ALTER TABLE vehicle_latest_locations ADD COLUMN provider TEXT;
-- Purge / provenance lookups touch only non-null providers.
CREATE INDEX idx_gps_locations_provider ON gps_locations (provider) WHERE provider IS NOT NULL;
