// Path helpers for the simulator. Distance comes from the single shared implementation
// (src/utils/haversine.js) — no second copy of the formula.
import { haversineMeters, M_PER_DEG_LAT, MIN_COS_LAT } from '../../utils/haversine.js';

const rad = (d) => (d * Math.PI) / 180;

/** [lat, lng] tuple convenience wrapper. */
export const haversineM = ([lat1, lng1], [lat2, lng2]) => haversineMeters(lat1, lng1, lat2, lng2);

/** Offset a point by (northM, eastM) metres (small-distance approximation on the same sphere). */
export function offsetM([lat, lng], northM, eastM) {
  return [lat + northM / M_PER_DEG_LAT, lng + eastM / (M_PER_DEG_LAT * Math.max(Math.cos(rad(lat)), MIN_COS_LAT))];
}

/** Precompute cumulative distances for a closed loop over the path. */
export function buildLoop(points) {
  const pts = points.length > 1 ? [...points, points[0]] : points;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineM(pts[i - 1], pts[i]));
  return { pts, cum, length: cum[cum.length - 1] };
}

/** Position after travelling `distM` along the loop (wraps around); returns { pos, heading }. */
export function positionAlong(loop, distM) {
  if (loop.pts.length === 1 || loop.length === 0) return { pos: loop.pts[0], heading: 0 };
  const d = ((distM % loop.length) + loop.length) % loop.length;
  let i = 1;
  while (i < loop.cum.length - 1 && loop.cum[i] < d) i++;
  const segStart = loop.cum[i - 1];
  const segLen = loop.cum[i] - segStart || 1;
  const t = (d - segStart) / segLen;
  const [a, b] = [loop.pts[i - 1], loop.pts[i]];
  const pos = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const heading = ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 360;
  return { pos, heading };
}
