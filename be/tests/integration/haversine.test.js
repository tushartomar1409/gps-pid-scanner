import { describe, it, expect } from 'vitest';
import { pool } from '../../src/config/database.js';
import { haversineMeters, bboxAround } from '../../src/utils/haversine.js';

describe('haversine (JS) and haversine_m (SQL)', () => {
  it('matches flow §8.1: (28.4082, 77.3178) <-> (28.4084, 77.3179) ≈ 24 m', async () => {
    const js = haversineMeters(28.4082, 77.3178, 28.4084, 77.3179);
    expect(js).toBeGreaterThan(23.5);
    expect(js).toBeLessThan(25);
    const { rows: [r] } = await pool.query('SELECT haversine_m(28.4082, 77.3178, 28.4084, 77.3179) AS d');
    expect(Math.abs(r.d - js)).toBeLessThan(0.01);
  });

  it('JS and SQL agree within 0.01 m on 1,000 random pairs inside India (one query)', async () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pairs = Array.from({ length: 1000 }, () => {
      const lat1 = 8 + rnd() * 28; const lng1 = 69 + rnd() * 27;
      // mix of near (≤ 500 m) and far pairs
      const far = rnd() < 0.3;
      const lat2 = lat1 + (rnd() - 0.5) * (far ? 10 : 0.01); const lng2 = lng1 + (rnd() - 0.5) * (far ? 10 : 0.01);
      return [lat1, lng1, lat2, lng2];
    });
    const cols = [0, 1, 2, 3].map((i) => pairs.map((p) => p[i]));
    const { rows } = await pool.query(
      'SELECT haversine_m(a, b, c, d) AS d FROM unnest($1::float8[], $2::float8[], $3::float8[], $4::float8[]) WITH ORDINALITY AS t(a, b, c, d, i) ORDER BY i',
      cols);
    const maxDiff = Math.max(...rows.map((r, i) => Math.abs(r.d - haversineMeters(...pairs[i]))));
    expect(maxDiff).toBeLessThan(0.01);
  });

  it('bboxAround contains every point at the radius in all directions (incl. high latitude) and clamps near the poles', () => {
    for (const lat of [0, 28.4, 60, 75, 89.9]) {
      const r = 30;
      const b = bboxAround(lat, 77.3, r);
      for (let deg = 0; deg < 360; deg += 15) {
        // walk ~r metres in direction `deg` with small steps and check the end point is inside the bbox
        const a = (deg * Math.PI) / 180;
        const dLat = (r * Math.cos(a)) / 111_195;
        const dLng = (r * Math.sin(a)) / (111_195 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
        const [pl, pg] = [lat + dLat * 0.999, 77.3 + dLng * 0.999];
        expect(haversineMeters(lat, 77.3, pl, pg)).toBeLessThanOrEqual(r + 0.5);
        if (pl <= 90) {
          expect(pl).toBeGreaterThanOrEqual(b.minLat);
          expect(pl).toBeLessThanOrEqual(b.maxLat);
          expect(pg).toBeGreaterThanOrEqual(b.minLng);
          expect(pg).toBeLessThanOrEqual(b.maxLng);
        }
      }
      expect(Number.isFinite(b.minLng) && Number.isFinite(b.maxLng)).toBe(true);
    }
  });
});
