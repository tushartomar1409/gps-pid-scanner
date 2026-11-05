// Great-circle distance (flow.txt §8.1, §16). The SQL twin is haversine_m() in 0005_phase4.sql —
// keep both formulas identical (parity-tested to 0.01 m).
export const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean Earth radius
const rad = (d) => (d * Math.PI) / 180;

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Metres per degree of latitude on the sphere used above (≈ 111,195 m). */
export const M_PER_DEG_LAT = (EARTH_RADIUS_M * Math.PI) / 180;
/** cos(lat) is clamped so the longitude window stays finite near the poles. */
export const MIN_COS_LAT = 0.01;

/**
 * Distance (m) from point P to segment A-B — JS twin of SQL seg_dist_m(). Local equirectangular
 * projection around A (same sphere), then planar point-to-segment distance. Accurate for short segments
 * (≤ 200 m: error ≪ GPS noise).
 */
export function pointToSegmentMeters(plat, plng, alat, alng, blat, blng) {
  const c = Math.cos(rad(alat));
  const px = (plng - alng) * M_PER_DEG_LAT * c;
  const py = (plat - alat) * M_PER_DEG_LAT;
  const dx = (blng - alng) * M_PER_DEG_LAT * c;
  const dy = (blat - alat) * M_PER_DEG_LAT;
  const dd = dx * dx + dy * dy;
  if (dd === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / dd));
  return Math.hypot(px - dx * t, py - dy * t);
}

/**
 * Bounding box guaranteed to contain every point within radiusM of (lat, lng): a cheap, index-friendly
 * prefilter before the exact Haversine check. A 1 % margin absorbs float/rounding differences.
 */
export function bboxAround(lat, lng, radiusM) {
  const dLat = (radiusM / M_PER_DEG_LAT) * 1.01;
  const dLng = (radiusM / (M_PER_DEG_LAT * Math.max(Math.cos(rad(lat)), MIN_COS_LAT))) * 1.01;
  return {
    minLat: Math.max(-90, lat - dLat), maxLat: Math.min(90, lat + dLat),
    minLng: Math.max(-180, lng - dLng), maxLng: Math.min(180, lng + dLng),
  };
}
