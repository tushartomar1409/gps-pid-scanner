-- 0002_seed_reference.sql — roles + permissions, default system settings (flow.txt §4, §8.2).
-- Idempotent (ON CONFLICT) so re-seeding never duplicates; runner still applies it once.
--
-- Permission vocabulary: <module>:read | <module>:write, plus reports:export.
-- '*' = all permissions (SUPER_ADMIN only).
-- DEPARTMENT_ADMIN (GUIDE #2 Q3): org-wide read + operational management (pids, routes, assignments);
--   no users/settings administration, no master (zone/ward/agency/vehicle) writes.
-- Row-level scope (zone/ward/agency) is applied separately by scopeMiddleware, not by permissions.

INSERT INTO roles (role_key, role_name, permissions) VALUES
  ('SUPER_ADMIN', 'Super Admin', '["*"]'),
  ('DEPARTMENT_ADMIN', 'Department Admin', '[
     "zones:read","wards:read","agencies:read","vehicles:read",
     "pids:read","pids:write","routes:read","routes:write","assignments:read","assignments:write",
     "gps:read","visits:read","dashboard:read","reports:read","reports:export","settings:read"]'),
  ('ZONE_ADMIN', 'Zone Admin', '[
     "zones:read","wards:read","agencies:read","vehicles:read",
     "pids:read","routes:read","assignments:read",
     "gps:read","visits:read","dashboard:read","reports:read","reports:export"]'),
  ('WARD_SUPERVISOR', 'Ward Supervisor', '[
     "zones:read","wards:read","agencies:read","vehicles:read",
     "pids:read","routes:read","assignments:read",
     "gps:read","visits:read","dashboard:read","reports:read","reports:export"]'),
  ('AGENCY_USER', 'Agency User', '[
     "zones:read","wards:read","agencies:read","vehicles:read",
     "routes:read","assignments:read",
     "gps:read","visits:read","dashboard:read","reports:read","reports:export"]')
ON CONFLICT (role_key) DO UPDATE SET role_name = EXCLUDED.role_name, permissions = EXCLUDED.permissions;

INSERT INTO system_settings (setting_key, setting_value, description) VALUES
  ('detection.radius_m',            '30',     'PID detection radius in metres'),
  ('detection.max_gps_age_s',       '300',    'Maximum acceptable GPS data age in seconds'),
  ('detection.min_speed_kmh',       'null',   'Minimum vehicle speed for a qualifying point (null = no minimum)'),
  ('detection.max_speed_kmh',       'null',   'Maximum vehicle speed for a qualifying point (null = no maximum)'),
  ('detection.consecutive_points',  '2',      'Consecutive qualifying GPS points required for GPS_VISIT_CONFIRMED'),
  ('detection.duplicate_prevention','true',   'Prevent duplicate visit counting per assignment/PID/day'),
  ('detection.enabled',             'true',   'Master switch for PID visit detection'),
  ('app.timezone',                  '"Asia/Kolkata"', 'Operational timezone used to derive operational_date')
ON CONFLICT (setting_key) DO NOTHING;
