import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { env } from '../../src/config/env.js';
import { todayInTz } from '../../src/utils/time.js';
import { createUser, createAgency, createVehicle, createRouteWithPids, bearer } from '../helpers/fixtures.js';

let app; let admin; let agencyA; let agencyB; let v; let route;

async function setLatest(vehicleId, msAgo, lat = 28.4) {
  const at = new Date(Date.now() - msAgo);
  const g = (await pool.query(
    `INSERT INTO gps_locations (vehicle_id, device_id, latitude, longitude, speed, recorded_at, provider) VALUES ($1, 'D', $2, 77.3, 12, $3, 'stub') RETURNING id`,
    [vehicleId, lat, at])).rows[0];
  await pool.query(
    `INSERT INTO vehicle_latest_locations (vehicle_id, gps_location_id, latitude, longitude, speed, recorded_at, provider)
     VALUES ($1, $2, $3, 77.3, 12, $4, 'stub') ON CONFLICT (vehicle_id) DO UPDATE SET recorded_at = EXCLUDED.recorded_at`,
    [vehicleId, g.id, lat, at]);
}

beforeAll(async () => {
  app = createApp();
  admin = await createUser('SUPER_ADMIN');
  agencyA = await createAgency();
  agencyB = await createAgency();
  v = {
    online: await createVehicle({ agency_id: agencyA.id }),
    offline: await createVehicle({ agency_id: agencyA.id }),
    nodata: await createVehicle({ agency_id: agencyA.id }),
    inactive: await createVehicle({ agency_id: agencyA.id }),
    other: await createVehicle({ agency_id: agencyB.id }),
  };
  await setLatest(v.online.id, 60_000);
  await setLatest(v.offline.id, 3600_000);
  await setLatest(v.inactive.id, 30_000);
  await setLatest(v.other.id, 30_000);
  await pool.query("UPDATE vehicles SET status = 'MAINTENANCE' WHERE id = $1", [v.inactive.id]);
  ({ route } = await createRouteWithPids(2));
  await pool.query(
    'INSERT INTO route_assignments (route_id, vehicle_id, operational_date, assigned_pid_count) VALUES ($1, $2, $3, 2)',
    [route.id, v.online.id, todayInTz('Asia/Kolkata')]);
});

describe('GET /api/gps/live-vehicles', () => {
  it('derives ONLINE / OFFLINE / NO_DATA / INACTIVE and joins today’s assignment', async () => {
    const res = await request(app).get(`/api/gps/live-vehicles?agency_id=${agencyA.id}`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.vehicles.map((x) => [x.vehicle_id, x]));
    expect(byId[v.online.id]).toMatchObject({ connection_status: 'ONLINE', route_code: route.route_code, assigned_pid_count: 2, latitude: 28.4 });
    expect(byId[v.offline.id].connection_status).toBe('OFFLINE');
    expect(byId[v.nodata.id]).toMatchObject({ connection_status: 'NO_DATA', latitude: null });
    expect(byId[v.inactive.id].connection_status).toBe('INACTIVE');
    expect(byId[v.other.id]).toBeUndefined();
    expect(res.body.data.truncated).toBe(false);
  });

  it('filters by connection_status and route_id', async () => {
    const offline = await request(app).get(`/api/gps/live-vehicles?agency_id=${agencyA.id}&connection_status=OFFLINE`).set(bearer(admin.token));
    expect(offline.body.data.vehicles.map((x) => x.vehicle_id)).toEqual([v.offline.id]);
    const byRoute = await request(app).get(`/api/gps/live-vehicles?route_id=${route.id}`).set(bearer(admin.token));
    expect(byRoute.body.data.vehicles.map((x) => x.vehicle_id)).toEqual([v.online.id]);
    expect((await request(app).get('/api/gps/live-vehicles?connection_status=MAYBE').set(bearer(admin.token))).status).toBe(400);
  });

  it('agency users only see their own vehicles; gps:read is required', async () => {
    const u = await createUser('AGENCY_USER', { agency_id: agencyB.id });
    const res = await request(app).get('/api/gps/live-vehicles').set(bearer(u.token));
    expect(res.body.data.vehicles.every((x) => x.agency_id === agencyB.id)).toBe(true);
    expect(res.body.data.vehicles.map((x) => x.vehicle_id)).toContain(v.other.id);
    expect((await request(app).get(`/api/vehicles/${v.online.id}/latest-location`).set(bearer(u.token))).status).toBe(404);
    expect((await request(app).get('/api/gps/live-vehicles')).status).toBe(401);
  });
});

describe('history', () => {
  let hv; const start = new Date('2026-11-01T00:00:00Z');
  beforeAll(async () => {
    hv = await createVehicle({ agency_id: agencyA.id });
    await pool.query(
      `INSERT INTO gps_locations (vehicle_id, device_id, latitude, longitude, recorded_at)
       SELECT $1, 'H', 28.4 + g * 0.0001, 77.3, $2::timestamptz + make_interval(mins => g) FROM generate_series(0, 99) g`,
      [hv.id, start]);
  });
  const win = (h = 6) => `from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(new Date(start.getTime() + h * 3600_000).toISOString())}`;

  it('returns all points ordered when under max_points', async () => {
    const res = await request(app).get(`/api/gps/vehicle-history?vehicle_id=${hv.id}&${win()}`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total_in_window: 100, downsampled: false });
    const times = res.body.data.points.map((p) => Date.parse(p.recorded_at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('downsamples in SQL to ≤ max_points, keeping the first and last point', async () => {
    for (const max of [10, 7, 3, 2]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(`/api/gps/vehicle-history?vehicle_id=${hv.id}&${win()}&max_points=${max}`).set(bearer(admin.token));
      const pts = res.body.data.points;
      expect(res.body.data.downsampled).toBe(true);
      expect(pts.length).toBeLessThanOrEqual(max);
      expect(pts.length).toBeGreaterThanOrEqual(2);
      expect(pts[0].recorded_at).toBe(start.toISOString());
      expect(pts.at(-1).recorded_at).toBe(new Date(start.getTime() + 99 * 60_000).toISOString());
    }
  });

  it('rejects windows over 24 h, reversed windows and timestamps without offset', async () => {
    expect((await request(app).get(`/api/gps/vehicle-history?vehicle_id=${hv.id}&${win(25)}`).set(bearer(admin.token))).status).toBe(400);
    const rev = `from=${encodeURIComponent('2026-11-02T00:00:00Z')}&to=${encodeURIComponent('2026-11-01T00:00:00Z')}`;
    expect((await request(app).get(`/api/gps/vehicle-history?vehicle_id=${hv.id}&${rev}`).set(bearer(admin.token))).status).toBe(400);
    expect((await request(app).get(`/api/gps/vehicle-history?vehicle_id=${hv.id}&from=2026-11-01T00:00:00&to=2026-11-01T05:00:00`).set(bearer(admin.token))).status).toBe(400);
  });

  it('flow §17 aliases: /vehicles/:id/history and /vehicles/:id/latest-location', async () => {
    const h = await request(app).get(`/api/vehicles/${hv.id}/history?${win()}&max_points=5`).set(bearer(admin.token));
    expect(h.status).toBe(200);
    expect(h.body.data).toMatchObject({ vehicle_id: hv.id, total_in_window: 100, downsampled: true });
    const l = await request(app).get(`/api/vehicles/${v.online.id}/latest-location`).set(bearer(admin.token));
    expect(l.body.data).toMatchObject({ vehicle_id: v.online.id, connection_status: 'ONLINE' });
    // CRUD routes under /vehicles still work next to the aliases
    expect((await request(app).get(`/api/vehicles/${hv.id}`).set(bearer(admin.token))).body.data.id).toBe(hv.id);
  });
});

describe('provider status + poll-now', () => {
  it('reports the state machine over the provider’s recent runs', async () => {
    const name = env.GPS_PROVIDER;
    await pool.query('DELETE FROM gps_poll_runs WHERE provider = $1', [name]);
    const res0 = await request(app).get('/api/gps/provider-status').set(bearer(admin.token));
    expect(res0.body.data).toMatchObject({ provider: name, state: 'DOWN', last_run: null });

    await pool.query(
      `INSERT INTO gps_poll_runs (provider, started_at, finished_at, outcome, records_received, records_saved)
       SELECT $1, now() - make_interval(secs => g * 60), now() - make_interval(secs => g * 60), CASE WHEN g <= 3 THEN 'FAILED' ELSE 'SUCCESS' END, 5, 5
         FROM generate_series(1, 5) g`, [name]);
    const down = await request(app).get('/api/gps/provider-status').set(bearer(admin.token));
    expect(down.body.data).toMatchObject({ state: 'DOWN', consecutive_failures: 3 });
    expect(down.body.data.recent_runs).toHaveLength(5);

    await pool.query(`INSERT INTO gps_poll_runs (provider, started_at, finished_at, outcome, records_received, records_saved, records_rejected)
                      VALUES ($1, now(), now(), 'PARTIAL', 10, 9, 1)`, [name]);
    const degraded = await request(app).get('/api/gps/provider-status').set(bearer(admin.token));
    expect(degraded.body.data).toMatchObject({ state: 'DEGRADED', consecutive_failures: 0 });
    expect(degraded.body.data.last_success_at).not.toBeNull();
  });

  it('poll-now: SUPER_ADMIN only, runs one MANUAL poll, and is limited to once per 30 s', async () => {
    const dept = await createUser('DEPARTMENT_ADMIN');
    const freshApp = createApp();
    expect((await request(freshApp).post('/api/gps/poll-now').set(bearer(dept.token))).status).toBe(403);
    const ok = await request(freshApp).post('/api/gps/poll-now').set(bearer(admin.token));
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ provider: 'simulator', trigger: 'MANUAL' });
    expect(['SUCCESS', 'PARTIAL']).toContain(ok.body.data.outcome);
    const run = (await pool.query('SELECT trigger, outcome FROM gps_poll_runs WHERE id = $1', [ok.body.data.pollRunId])).rows[0];
    expect(run.trigger).toBe('MANUAL');
    expect((await request(freshApp).post('/api/gps/poll-now').set(bearer(admin.token))).status).toBe(429);
  });
});
