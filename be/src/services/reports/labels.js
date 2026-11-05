// ONE server-side label map for reports (GUIDE #10 A). Must match fe/src/utils/visitStatus.js.
// Wording rule: GPS proximity is never "collected".

export const VISIT_STATUS_LABELS = Object.freeze({
  GPS_VISIT_CONFIRMED: 'GPS Visit Confirmed',
  GPS_VISIT_CANDIDATE: 'GPS Visit Candidate',
  NOT_VISITED: 'Not Visited',
  GPS_DATA_UNAVAILABLE: 'GPS Data Unavailable',
});

/** missed-pids: reason = the non-confirmed status, in this order (also the default sort). */
export const MISSED_REASON_ORDER = ['NOT_VISITED', 'GPS_DATA_UNAVAILABLE', 'GPS_VISIT_CANDIDATE'];

export const visitStatusLabel = (s) => VISIT_STATUS_LABELS[s] || s || '';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const metres = (v) => `${Math.round(Number(v))} m`;

/**
 * Compact "detection evidence" cell (GUIDE #10 A1), e.g.
 *   "2 GPS points (closest 12 m) · 1 track segment · ambiguous"
 * e = { points, closest_m, segments, rejected_speed, rejected_stale, ambiguous }
 * Rejected points are listed last and never counted as evidence of a visit.
 */
export function evidenceSummary(e = {}) {
  const parts = [];
  const points = Number(e.points) || 0;
  const segments = Number(e.segments) || 0;
  const rejSpeed = Number(e.rejected_speed) || 0;
  const rejStale = Number(e.rejected_stale) || 0;
  if (points) parts.push(`${plural(points, 'GPS point', 'GPS points')}${e.closest_m != null ? ` (closest ${metres(e.closest_m)})` : ''}`);
  if (segments) parts.push(plural(segments, 'track segment', 'track segments'));
  if (e.ambiguous && (points || segments)) parts.push('ambiguous');
  if (rejSpeed) parts.push(`${rejSpeed} rejected (speed)`);
  if (rejStale) parts.push(`${rejStale} rejected (stale)`);
  return parts.length ? parts.join(' · ') : 'No GPS evidence';
}
