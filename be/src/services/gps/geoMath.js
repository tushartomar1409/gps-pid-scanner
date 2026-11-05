// Small geo helpers for the simulator (Phase 4 adds the detection Haversine utilities).
const R = 6_371_000; // metres
const rad = (d) => (d * Math.PI) / 180;

export function haversineM([lat1, lng1], [lat2, lng2]) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Offset a point by (northM, eastM) metres (small-distance approximation). */
export function offsetM([lat, lng], northM, eastM) {
  return [lat + northM / 111_320, lng + eastM / (111_320 * Math.cos(rad(lat)))];
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
