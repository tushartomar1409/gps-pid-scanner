-- 0006_segment_evidence.sql — TRACK_SEGMENT evidence (GUIDE #8 answer 1, approved constraint change).
-- The only non-additive statement swaps the evidence_status CHECK to ADD one allowed value; nothing
-- else is loosened and no existing row is touched.

ALTER TABLE pid_visit_events DROP CONSTRAINT pid_visit_events_evidence_status_check;
ALTER TABLE pid_visit_events ADD CONSTRAINT pid_visit_events_evidence_status_check
  CHECK (evidence_status IN ('PROXIMITY_POINT','CONSECUTIVE_CONFIRMED','REJECTED_SPEED','REJECTED_STALE','TRACK_SEGMENT'));

-- Distance (m) from point P to segment A-B. Local equirectangular projection around A on the same sphere
-- as haversine_m (111,195.08 m per degree latitude, longitude scaled by cos(lat_A)), then planar
-- point-to-segment distance. Error is far below GPS noise for segments ≤ 200 m. JS twin: pointToSegmentMeters.
CREATE OR REPLACE FUNCTION seg_dist_m(plat double precision, plng double precision,
                                      alat double precision, alng double precision,
                                      blat double precision, blng double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN dd = 0 THEN sqrt(px * px + py * py)
              ELSE sqrt(power(px - dx * t, 2) + power(py - dy * t, 2)) END
    FROM (SELECT px, py, dx, dy, dd, greatest(0, least(1, (px * dx + py * dy) / nullif(dd, 0))) AS t
            FROM (SELECT (plng - alng) * 111195.08023353292 * cos(radians(alat)) AS px,
                         (plat - alat) * 111195.08023353292                      AS py,
                         (blng - alng) * 111195.08023353292 * cos(radians(alat)) AS dx,
                         (blat - alat) * 111195.08023353292                      AS dy,
                         power((blng - alng) * 111195.08023353292 * cos(radians(alat)), 2)
                           + power((blat - alat) * 111195.08023353292, 2)        AS dd) v) w
$$;

INSERT INTO system_settings (setting_key, setting_value, description) VALUES
  ('detection.segment_evidence_enabled', 'true', 'Use the track line between two consecutive valid GPS points as weak (CANDIDATE-only) evidence'),
  ('detection.segment_max_length_m', '200', 'Ignore segments longer than this (GPS gaps / teleports)'),
  ('detection.segment_max_gap_s', '90', 'Ignore segments whose two points are further apart in time than this')
ON CONFLICT (setting_key) DO NOTHING;
