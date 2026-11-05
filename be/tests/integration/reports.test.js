// Phase 6 reports (GUIDE #10 E): preview numbers/columns, scope, sort whitelist, range limit,
// XLSX round trip, CSV (BOM, quoting, injection, Hindi), PDF (pages, 5,000 cap), truncation, audit, rate limit.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { REPORTS } from '../../src/services/reports/definitions.js';
import { createUser, createAgency, createZone, createWard, createVehicle, bearer, uid } from '../helpers/fixtures.js';
import { makeAssignment, track, ist, insertEvents } from '../helpers/detection.js';

const D = '2034-04-10';
const HINDI = 'मकान नं. 12, सेक्टर 7, फरीदाबाद';
const EVIL = '=HYPERLINK("http://evil.example","click")';
let app; let zone; let w1; let w2; let a1; let a2; let v1; let v2; let asg1; let asg2;

const admin = () => createUser('SUPER_ADMIN'); // fresh user per export test: the 5/min limit is per user
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const setStatus = (raId, pidId, st, extra = '') => pool.query(`UPDATE pid_daily_status SET visit_status = $3 ${extra} WHERE route_assignment_id = $1 AND pid_id = $2`, [raId, pidId, st]);

/** n PIDs on one assignment in 6 statements (bulk; Neon RTT makes per-row inserts too slow). */
async function bulkAssignment(n, date) {
  const z = await createZone();
  const w = await createWard(z.id);
  const v = await createVehicle({ zone_id: z.id, ward_id: w.id });
  const s = uid();
  const route = (await pool.query("INSERT INTO routes (route_code, route_name, zone_id, ward_id) VALUES ($1, 'Bulk', $2, $3) RETURNING id", [`BR${s}`, z.id, w.id])).rows[0];
  const { rows: pids } = await pool.query(
    `INSERT INTO pids (pid_number, zone_id, ward_id, latitude, longitude, coord_status, address)
     SELECT 'BP${s}-' || lpad(g::text, 5, '0'), $1, $2, 28.4 + g * 1e-5, 77.3, 'IMPORTED',
            'House ' || g || ', a fairly long street name for wrapping tests, Sector ' || (g % 40) || ', Faridabad'
       FROM generate_series(1, $3) g RETURNING id`, [z.id, w.id, n]);
  const ra = (await pool.query('INSERT INTO route_assignments (route_id, vehicle_id, operational_date, assigned_pid_count) VALUES ($1, $2, $3, $4) RETURNING id', [route.id, v.id, date, n])).rows[0];
  await pool.query('INSERT INTO route_assignment_pids (route_assignment_id, pid_id, pid_latitude, pid_longitude) SELECT $1, p.id, p.latitude, p.longitude FROM pids p WHERE p.id = ANY($2)', [ra.id, pids.map((p) => p.id)]);
  await pool.query("INSERT INTO pid_daily_status (operational_date, route_assignment_id, pid_id, vehicle_id, visit_status) SELECT $1, $2, pid_id, $3, 'NOT_VISITED' FROM route_assignment_pids WHERE route_assignment_id = $2", [date, ra.id, v.id]);
  return { zone: z, raId: ra.id };
}

beforeAll(async () => {
  app = createApp();
  zone = await createZone();
  w1 = await createWard(zone.id);
  w2 = await createWard(zone.id);
  a1 = await createAgency();
  a2 = await createAgency();
  v1 = await createVehicle({ agency_id: a1.id, zone_id: zone.id, ward_id: w1.id });
  v2 = await createVehicle({ agency_id: a2.id, zone_id: zone.id, ward_id: w2.id });
  asg1 = await makeAssignment({ pids: [[28.5, 77.2], [28.501, 77.2], [28.502, 77.2], [28.503, 77.2]], date: D, vehicle: v1, routeWard: { zone, ward: w1 } });
  asg2 = await makeAssignment({ pids: [[28.6, 77.2], [28.601, 77.2], null], date: D, vehicle: v2, routeWard: { zone, ward: w2 } });
  await pool.query('UPDATE route_assignments SET agency_id = $2 WHERE id = $1', [asg1.raId, a1.id]);
  await pool.query('UPDATE route_assignments SET agency_id = $2 WHERE id = $1', [asg2.raId, a2.id]);
  await pool.query('UPDATE pids SET address = $2 WHERE id = $1', [asg1.pidIds[0], HINDI]);
  await pool.query('UPDATE pids SET address = $2 WHERE id = $1', [asg1.pidIds[1], EVIL]);
  await setStatus(asg1.raId, asg1.pidIds[0], 'GPS_VISIT_CONFIRMED', `, first_visit_at = '${ist(D, '09:05:00').toISOString()}', last_visit_at = '${ist(D, '09:06:00').toISOString()}', min_distance_meters = 12.4`);
  await setStatus(asg1.raId, asg1.pidIds[1], 'GPS_VISIT_CONFIRMED');
  await setStatus(asg1.raId, asg1.pidIds[2], 'GPS_VISIT_CANDIDATE');
  await setStatus(asg2.raId, asg2.pidIds[1], 'GPS_VISIT_CANDIDATE');
  const g = await track(v1.id, [{ p: [28.5, 77.2], t: ist(D, '09:05:00') }, { p: [28.5, 77.2001], t: ist(D, '09:06:00') }, { p: [28.502, 77.2], t: ist(D, '09:40:00') }]);
  await pool.query('UPDATE gps_locations SET processed_at = now() WHERE id = ANY($1)', [g]);
  await insertEvents([
    { raId: asg1.raId, pidId: asg1.pidIds[0], vehicleId: v1.id, gpsId: g[0], dist: 12.4, status: 'PROXIMITY_POINT', ambiguous: true, pidsInRadius: 2 },
    { raId: asg1.raId, pidId: asg1.pidIds[0], vehicleId: v1.id, gpsId: g[1], dist: 20, status: 'PROXIMITY_POINT' },
    { raId: asg1.raId, pidId: asg1.pidIds[0], vehicleId: v1.id, gpsId: g[2], dist: 9, status: 'TRACK_SEGMENT' },
    { raId: asg1.raId, pidId: asg1.pidIds[2], vehicleId: v1.id, gpsId: g[2], dist: 15, status: 'TRACK_SEGMENT' },
  ]);
});

const get = async (path, token) => request(app).get(path).set(bearer(token ?? (await admin()).token));
const q = (extra = '') => `date=${D}&zone_id=${zone.id}${extra}`;

describe('previews: numbers and columns (flow §14)', () => {
  it('daily-coverage: §14.1 columns, labels, evidence summary', async () => {
    const res = await get(`/api/reports/daily-coverage?${q()}&limit=50`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data;
    expect(d.columns.map((c) => c.header)).toEqual(['Date', 'Zone', 'Ward', 'PID number', 'Address', 'Route', 'Vehicle', 'Agency', 'Visit status',
      'First visit (IST)', 'Last visit (IST)', 'Distance from PID (m)', 'Detection evidence']);
    expect(d.pagination.total).toBe(7);
    const r = d.rows.find((x) => x.pid_id === asg1.pidIds[0]);
    expect(r).toMatchObject({ date: D, zone: zone.zone_name, ward: w1.ward_name, address: HINDI, vehicle: v1.vehicle_number, agency: a1.agency_name,
      visit_status: 'GPS_VISIT_CONFIRMED', visit_status_label: 'GPS Visit Confirmed', distance_m: 12.4,
      detection_evidence: '2 GPS points (closest 12 m) · 1 track segment · ambiguous' });
    expect(d.rows.find((x) => x.pid_id === asg1.pidIds[2]).detection_evidence).toBe('1 track segment');
    expect(d.rows.find((x) => x.pid_id === asg2.pidIds[0]).detection_evidence).toBe('No GPS evidence');
    expect((await get(`/api/reports/daily-coverage?${q()}&status=NOT_VISITED`)).body.data.pagination.total).toBe(2);
    expect(JSON.stringify(d)).not.toMatch(/collected_|"collected"|collection done/i);
  });

  it('missed-pids: every non-confirmed PID, reason column, default sort by reason, chip counts', async () => {
    const d = (await get(`/api/reports/missed-pids?${q()}`)).body.data;
    expect(d.rows.map((r) => r.missed_reason)).toEqual(['Not Visited', 'Not Visited', 'GPS Data Unavailable', 'GPS Visit Candidate', 'GPS Visit Candidate']);
    expect(d.reason_counts).toEqual([
      { reason: 'NOT_VISITED', label: 'Not Visited', count: 2 }, { reason: 'GPS_DATA_UNAVAILABLE', label: 'GPS Data Unavailable', count: 1 },
      { reason: 'GPS_VISIT_CANDIDATE', label: 'GPS Visit Candidate', count: 2 }]);
    const only = (await get(`/api/reports/missed-pids?${q('&status=GPS_DATA_UNAVAILABLE')}`)).body.data;
    expect(only.rows).toHaveLength(1);
    expect(only.reason_counts.find((c) => c.reason === 'NOT_VISITED').count).toBe(2); // chips ignore the reason filter
    expect((await get(`/api/reports/missed-pids?${q('&status=GPS_VISIT_CONFIRMED')}`)).status).toBe(400);
  });

  it('vehicle-wise (§14.2 + detected %), agency-wise (§14.3), ward-wise (§14.4)', async () => {
    const veh = Object.fromEntries((await get(`/api/reports/vehicle-wise?${q()}`)).body.data.rows.map((r) => [r.vehicle, r]));
    expect(veh[v1.vehicle_number]).toMatchObject({ date: D, agency: a1.agency_name, assigned_pids: 4, gps_confirmed: 2, remaining: 2, confirmed_pct: 50, detected_pct: 75 });
    expect(new Date(veh[v1.vehicle_number].first_gps).toISOString()).toBe(ist(D, '09:05:00').toISOString());
    expect(new Date(veh[v1.vehicle_number].last_gps).toISOString()).toBe(ist(D, '09:40:00').toISOString());
    expect(veh[v2.vehicle_number]).toMatchObject({ assigned_pids: 3, gps_confirmed: 0, remaining: 3, confirmed_pct: 0, detected_pct: 33.3, first_gps: null });

    const ag = Object.fromEntries((await get(`/api/reports/agency-wise?${q()}`)).body.data.rows.map((r) => [r.agency, r]));
    expect(ag[a1.agency_name]).toEqual({ agency: a1.agency_name, assigned_vehicles: 1, active_vehicles: 1, assigned_pids: 4, gps_confirmed: 2, remaining: 2, confirmed_pct: 50, detected_pct: 75 });
    expect(ag[a2.agency_name]).toMatchObject({ assigned_vehicles: 1, active_vehicles: 0, assigned_pids: 3, confirmed_pct: 0, detected_pct: 33.3 });

    const wards = (await get(`/api/reports/ward-wise?${q()}`)).body.data;
    expect(wards.columns.map((c) => c.key)).toEqual(['zone', 'ward', 'assigned_pids', 'gps_confirmed', 'remaining', 'confirmed_pct', 'detected_pct']);
    const wm = Object.fromEntries(wards.rows.map((r) => [r.ward, r]));
    expect(wm[w1.ward_name]).toMatchObject({ zone: zone.zone_name, assigned_pids: 4, gps_confirmed: 2, remaining: 2, confirmed_pct: 50, detected_pct: 75 });
    expect(wm[w2.ward_name]).toMatchObject({ assigned_pids: 3, gps_confirmed: 0, remaining: 3 });
  });

  it('scope: ward supervisor sees only their ward; agency user only their agency', async () => {
    const ws = await createUser('WARD_SUPERVISOR', { zone_id: zone.id, ward_id: w1.id });
    expect((await get(`/api/reports/daily-coverage?date=${D}`, ws.token)).body.data.pagination.total).toBe(4);
    const au = await createUser('AGENCY_USER', { agency_id: a2.id });
    const rows = (await get(`/api/reports/ward-wise?date=${D}`, au.token)).body.data.rows;
    expect(rows.map((r) => r.ward)).toEqual([w2.ward_name]);
    expect((await get(`/api/reports/missed-pids?date=${D}`, au.token)).body.data.reason_counts.map((c) => c.count)).toEqual([1, 1, 1]);
  });

  it('sorting whitelist, sort direction, date-range limit, validation', async () => {
    const t = (await admin()).token;
    const bad = await get(`/api/reports/daily-coverage?${q('&sort=password_hash')}`, t);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/Allowed: /);
    const sorted = (await get(`/api/reports/daily-coverage?${q('&sort=distance_m&dir=desc')}`, t)).body.data.rows;
    expect(sorted[0].distance_m).toBe(12.4); // nulls last
    expect((await get('/api/reports/ward-wise?from=2034-01-01&to=2034-03-10', t)).status).toBe(400);
    expect((await get('/api/reports/ward-wise?from=2034-03-10&to=2034-03-01', t)).status).toBe(400);
    expect((await get('/api/reports/ward-wise?from=2034-03-01&to=2034-03-31', t)).status).toBe(200); // exactly 31 days
    expect((await get(`/api/reports/ward-wise?${q('&status=NOT_VISITED')}`, t)).status).toBe(400);
    expect((await request(app).get('/api/reports/ward-wise')).status).toBe(401);
  });
});

describe('exports', () => {
  it('XLSX round trip: headers, rows, IST dates, % number format, frozen + filtered header, About sheet', async () => {
    const res = await request(app).get(`/api/reports/vehicle-wise?${q('&format=xlsx')}`).set(bearer((await admin()).token)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="vehicle-wise_${D}_all.xlsx"`);
    expect(res.headers['cache-control']).toBe('no-store');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('Report');
    expect(ws.getRow(1).values.slice(1)).toEqual(REPORTS['vehicle-wise'].columns.map((c) => c.header));
    expect(ws.getRow(1).font?.bold ?? ws.getRow(1).getCell(1).font?.bold).toBe(true);
    expect(ws.rowCount).toBe(3);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();
    const row = [2, 3].map((i) => ws.getRow(i)).find((r) => r.getCell(2).value === v1.vehicle_number);
    const idx = (k) => REPORTS['vehicle-wise'].columns.findIndex((c) => c.key === k) + 1;
    expect(row.getCell(idx('confirmed_pct')).value).toBe(50);
    expect(row.getCell(idx('confirmed_pct')).numFmt).toBe('0.0"%"');
    expect(row.getCell(idx('detected_pct')).value).toBe(75);
    expect(row.getCell(idx('first_gps')).value).toBe(`${D} 09:05`);
    const about = Object.fromEntries(wb.getWorksheet('About').getSheetValues().slice(2).map((r) => [r[1], r[2]]));
    expect(about.Filters).toBe(`Date ${D} · Zone id: ${zone.id}`);
    expect(about['Row count']).toBe('2');
    expect(about.Disclaimer).toMatch(/does not prove that garbage was collected/);
    expect(about).toHaveProperty('Detection radius (m)');
    expect(about['Segment evidence']).toMatch(/^(on|off)$/);
    expect(about['Generated by']).toMatch(/SUPER_ADMIN/);
  });

  it('CSV: BOM, RFC 4180 quoting, injection guard, Hindi round trip; EXPORT audit row', async () => {
    const u = await admin();
    const res = await request(app).get(`/api/reports/daily-coverage?${q('&format=csv')}`).set(bearer(u.token)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const text = res.body.toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Date,Zone,Ward,PID number,Address,Route,Vehicle,Agency,Visit status,First visit (IST),Last visit (IST),Distance from PID (m),Detection evidence');
    expect(lines).toHaveLength(8);
    expect(text).toContain(HINDI);
    expect(text).toContain('"\'=HYPERLINK(""http://evil.example"",""click"")"'); // apostrophe-guarded, quotes doubled
    expect(text).not.toMatch(/,=HYPERLINK/);
    expect(text).toContain(`${D} 09:05`);
    // The audit row is written right after the last byte is sent, so it can land a moment after the client finishes.
    const audit = await vi.waitFor(async () => {
      const r = (await pool.query("SELECT details FROM activity_logs WHERE user_id = $1 AND action = 'EXPORT' AND module = 'reports'", [u.user.id])).rows;
      expect(r).toHaveLength(1);
      return r;
    }, { timeout: 10_000, interval: 300 });
    expect(audit[0].details).toMatchObject({ report: 'daily-coverage', format: 'csv', row_count: 7, filters: { from: D, to: D, zone_id: zone.id } });
  });

  it('PDF: %PDF, multi-page for 200 rows, footer pages; > 5,000 rows -> 422 before any bytes', async () => {
    const b200 = await bulkAssignment(200, '2034-05-01');
    const res = await request(app).get(`/api/reports/daily-coverage?date=2034-05-01&zone_id=${b200.zone.id}&format=pdf`).set(bearer((await admin()).token)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    const pages = (res.body.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    expect(pages).toBeGreaterThan(3);

    const big = await bulkAssignment(5001, '2034-05-02');
    const r2 = await request(app).get(`/api/reports/daily-coverage?date=2034-05-02&zone_id=${big.zone.id}&format=pdf`).set(bearer((await admin()).token));
    expect(r2.status).toBe(422);
    expect(r2.headers['content-type']).toMatch(/json/);
    expect(r2.body.message).toMatch(/Too many rows for PDF.*use Excel/);
  }, 240_000);

  it('a failure mid-stream aborts the connection (never a 200 that looks complete)', async () => {
    const big = (await pool.query("SELECT r.zone_id FROM route_assignments ra JOIN routes r ON r.id = ra.route_id WHERE ra.operational_date = '2034-05-02'")).rows[0];
    const def = REPORTS['daily-coverage'];
    const orig = def.record;
    let n = 0;
    def.record = (r) => {
      if (++n === 3000) throw new Error('boom mid-stream');
      return orig(r);
    };
    const server = http.createServer(app).listen(0);
    try {
      const token = (await admin()).token;
      const outcome = await new Promise((resolve) => {
        const req = http.get({ port: server.address().port, path: `/api/reports/daily-coverage?date=2034-05-02&zone_id=${big.zone_id}&format=csv`, headers: bearer(token) }, (res) => {
          let bytes = 0;
          res.on('data', (c) => { bytes += c.length; });
          res.on('end', () => resolve({ status: res.statusCode, complete: res.complete, bytes, ended: true }));
          res.on('error', (e) => resolve({ status: res.statusCode, complete: res.complete, bytes, error: e.message }));
          res.on('aborted', () => resolve({ status: res.statusCode, complete: false, bytes, aborted: true }));
        });
        req.on('error', (e) => resolve({ error: e.message, complete: false }));
      });
      expect(outcome.complete).toBe(false);
      expect(outcome.ended).toBeUndefined();
    } finally {
      def.record = orig;
      server.close();
    }
  }, 120_000);

  it('vehicle-tracking: CSV/XLSX only, full-resolution points; export-excel alias', async () => {
    const t = (await admin()).token;
    const res = await request(app).get(`/api/reports/vehicle-tracking?vehicle_id=${v1.id}&date=${D}&start=09:00&end=10:00&format=csv`).set(bearer(t)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const lines = res.body.toString('utf8').slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Time (IST),Vehicle,Latitude,Longitude,Speed (km/h),Ignition');
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual([`${D} 09:05`, `${D} 09:06`, `${D} 09:40`]);
    expect((await request(app).get(`/api/reports/vehicle-tracking?vehicle_id=${v1.id}&date=${D}&format=pdf`).set(bearer(t))).status).toBe(400);
    const au = await createUser('AGENCY_USER', { agency_id: a2.id });
    const scoped = await request(app).get(`/api/reports/vehicle-tracking?vehicle_id=${v1.id}&date=${D}&format=csv`).set(bearer(au.token)).buffer(true).parse(binary);
    expect(scoped.body.toString('utf8').slice(1).trim().split('\r\n')).toHaveLength(1); // header only: v1 is outside agency 2
    const alias = await request(app).get(`/api/reports/export-excel?report=ward-wise&${q()}`).set(bearer(t)).buffer(true).parse(binary);
    expect(alias.status).toBe(200);
    expect(alias.headers['content-disposition']).toMatch(/ward-wise_2034-04-10_all\.xlsx/);
  });

  it('rate limit: 5 exports per minute per user -> 429', async () => {
    const t = (await admin()).token;
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      expect((await request(app).get(`/api/reports/ward-wise?${q('&format=csv')}`).set(bearer(t))).status).toBe(200);
    }
    const sixth = await request(app).get(`/api/reports/ward-wise?${q('&format=csv')}`).set(bearer(t));
    expect(sixth.status).toBe(429);
    expect(sixth.body.message).toMatch(/Export limit reached/);
    expect((await request(app).get(`/api/reports/ward-wise?${q()}`).set(bearer(t))).status).toBe(200); // previews are not limited
    expect((await request(app).get(`/api/reports/ward-wise?${q('&format=csv')}`).set(bearer((await admin()).token))).status).toBe(200); // other users unaffected
  });
});

