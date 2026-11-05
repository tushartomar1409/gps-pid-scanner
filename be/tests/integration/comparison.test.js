// Route comparison (GUIDE #8 D/F): GPS distance with jitter/outlier filtering, reliability, PostGIS deviation.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { createUser, createAgency, bearer } from '../helpers/fixtures.js';
import { ORIGIN, at, makeAssignment, track, ist } from '../helpers/detection.js';

let app; let admin; let day = 0;
const date = () => `2032-01-${String(10 + day++).padStart(2, '0')}`;

/** Route along the street east from ORIGIN (0 .. 1000 m) with geometry; returns the assignment. */
async function routeWithLine(d) {
  const a = await makeAssignment({ pids: [at(5, 500)], date: d });
  const line = { type: 'LineString', coordinates: [at(0, 0), at(0, 1000)].map(([lat, lng]) => [lng, lat]) };
  await pool.query('UPDATE routes SET route_geometry = $2 WHERE id = $1', [a.routeId, JSON.stringify(line)]);
  return a;
}
const every30s = (d, xs, north = () => 0) =>
  xs.map((x, i) => ({ p: at(north(x), x), t: new Date(ist(d, '09:00:00').getTime() + i * 30_000), speed: 15 }));
const compare = (raId, token = admin.token) => request(app).get(`/api/route-assignments/${raId}/comparison`).set(bearer(token));

beforeAll(async () => {
  app = createApp();
  admin = await createUser('SUPER_ADMIN');
});

describe('GET /api/route-assignments/:id/comparison', () => {
  it('straight 1 km track: distance within ±1 %, reliable, nothing off-route', async () => {
    const d = date();
    const a = await routeWithLine(d);
    await track(a.vehicle.id, every30s(d, Array.from({ length: 21 }, (_, i) => i * 50)));
    const res = await compare(a.raId);
    expect(res.status).toBe(200);
    const c = res.body.data;
    expect(Math.abs(c.gps_route_distance_m - 1000)).toBeLessThanOrEqual(10);
    expect(c.distance_quality).toMatchObject({ reliable: true, reasons: [], points: 21 });
    expect(c.route_deviation).toMatchObject({ threshold_m: 50, points_off_route: 0, pct_off_route: 0, off_route_segments: [] });
    expect(c.assigned_geometry.type).toBe('LineString');
    expect(c.actual_track).toMatchObject({ total_in_window: 21, downsampled: false });
    expect(c.counts).toMatchObject({ assigned: 1, confirmed: 0, remaining: 1, confirmed_pct: 0 });
    expect(new Date(c.first_gps_activity).toISOString()).toBe(ist(d, '09:00:00').toISOString());
    expect(c.disclaimer).toMatch(/does not prove/);
  });

  it('a stationary jitter-only track gives ~0 m', async () => {
    const d = date();
    const a = await routeWithLine(d);
    const jitter = [0, 1.5, -1, 2, -2, 0.5, 1, -1.5, 2.5, 0, 1, -0.5];
    await track(a.vehicle.id, jitter.map((j, i) => ({ p: at(j, 300 + jitter[(i + 3) % jitter.length]), t: new Date(ist(d, '10:00:00').getTime() + i * 30_000), speed: 0 })));
    const c = (await compare(a.raId)).body.data;
    expect(c.gps_route_distance_m).toBeLessThanOrEqual(2);
    expect(c.distance_quality.jitter_segments_skipped).toBeGreaterThanOrEqual(10);
  });

  it('a teleport outlier (5 km jump and back) is excluded', async () => {
    const d = date();
    const a = await routeWithLine(d);
    const pts = every30s(d, Array.from({ length: 21 }, (_, i) => i * 50));
    pts[10] = { ...pts[10], p: at(5000, 500) };
    await track(a.vehicle.id, pts);
    const c = (await compare(a.raId)).body.data;
    expect(c.distance_quality.outlier_segments_skipped).toBe(2);
    // the two segments around the outlier are dropped: 1000 m minus the 2 × 50 m around point 10
    expect(Math.abs(c.gps_route_distance_m - 900)).toBeLessThanOrEqual(9);
  });

  it('marks the distance unreliable for a > 10 min gap or < 10 points', async () => {
    const d = date();
    const a = await routeWithLine(d);
    const pts = every30s(d, Array.from({ length: 12 }, (_, i) => i * 50));
    for (let i = 6; i < pts.length; i++) pts[i] = { ...pts[i], t: new Date(pts[i].t.getTime() + 15 * 60_000) };
    await track(a.vehicle.id, pts);
    const c = (await compare(a.raId)).body.data;
    expect(c.distance_quality.reliable).toBe(false);
    expect(c.distance_quality.max_gap_s).toBe(930); // 15 min shift + the 30 s step
    expect(c.distance_quality.reasons.join(' ')).toMatch(/GPS gap of 16 min \(> 10 min\)/);

    const d2 = date();
    const b = await routeWithLine(d2);
    await track(b.vehicle.id, every30s(d2, [0, 50, 100]));
    expect((await compare(b.raId)).body.data.distance_quality.reasons.join(' ')).toMatch(/Only 3 GPS points/);
  });

  it('a 100 m detour north for 200..400 m gives one off-route segment (PostGIS)', async () => {
    const d = date();
    const a = await routeWithLine(d);
    const xs = Array.from({ length: 21 }, (_, i) => i * 50);
    await track(a.vehicle.id, every30s(d, xs, (x) => (x >= 200 && x <= 400 ? 100 : 0)));
    const dev = (await compare(a.raId)).body.data.route_deviation;
    expect(dev.points_off_route).toBe(5); // x = 200, 250, 300, 350, 400
    expect(dev.off_route_segment_count).toBe(1);
    expect(dev.off_route_segments).toHaveLength(1);
    expect(dev.off_route_segments[0].max_m).toBeGreaterThan(99);
    expect(dev.off_route_segments[0].max_m).toBeLessThan(101);
    expect(dev.max_deviation_m).toBeCloseTo(100, 0);
    expect(dev.pct_off_route).toBe(23.8);
    expect(new Date(dev.off_route_segments[0].from).toISOString()).toBe(new Date(ist(d, '09:02:00')).toISOString());
  });

  it('route without geometry -> route_deviation null; scope applies', async () => {
    const d = date();
    const a = await makeAssignment({ pids: [ORIGIN], date: d });
    await track(a.vehicle.id, every30s(d, [0, 50]));
    expect((await compare(a.raId)).body.data.route_deviation).toBeNull();
    const u = await createUser('AGENCY_USER', { agency_id: (await createAgency()).id });
    expect((await compare(a.raId, u.token)).status).toBe(404);
  });
});
