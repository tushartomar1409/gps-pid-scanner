-- 0010_security.sql — auth hardening (GUIDE #11 C2). Additive only.
ALTER TABLE users
  -- Bumped on password change, deactivation and "log out all sessions"; carried in the JWT (tv) and
  -- compared on every request and by the socket re-check, so old tokens stop working immediately.
  ADD COLUMN token_version INT NOT NULL DEFAULT 0,
  -- Per-account lockout: 10 failed logins within 15 min lock the account for 15 min (on top of the IP limit).
  ADD COLUMN failed_login_count INT NOT NULL DEFAULT 0,
  ADD COLUMN failed_login_window_start TIMESTAMPTZ,
  ADD COLUMN locked_until TIMESTAMPTZ;
