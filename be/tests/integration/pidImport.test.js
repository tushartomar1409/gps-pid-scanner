import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { createUser, createZoneWard, createPid, createRoute, bearer, uid } from '../helpers/fixtures.js';

const HEADER = 'PID_Number, Owner_Name ,mobile,address,ZONE_CODE,ward_number,latitude,longitude,route_code';

let app; let admin; let zw; let otherZw; let route; let foreignRoute; let existing; let manual;

const csv = (lines) => Buffer.from(`${[HEADER, ...lines].join('\n')}\n`);
const upload = (buf, name, query) =>
  request(app).post(`/api/pids/import?${query}`).set(bearer(admin.token)).attach('file', buf, name);
const findingsFor = (body, pid) => body.data.findings.filter((f) => f.pid_number === pid);

beforeAll(async () => {
  app = createApp();
  admin = await createUser('SUPER_ADMIN');
  zw = await createZoneWard();
  otherZw = await createZoneWard();
  route = await createRoute({ zone_id: zw.zone.id, ward_id: zw.ward.id });
  foreignRoute = await createRoute({ zone_id: otherZw.zone.id, ward_id: otherZw.ward.id });
  existing = await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id, latitude: 28.31, longitude: 77.31 });
  manual = await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id, latitude: 28.32, longitude: 77.32 });
  await pool.query("UPDATE pids SET coord_status = 'MANUALLY_CORRECTED' WHERE id = $1", [manual.id]);
});

describe('PID import — validate mode', () => {
  it('reports every error and warning type without writing anything', async () => {
    const s = uid();
    const Z = zw.zone.zone_code;
    const W = zw.ward.ward_number;
    const rows = {
      ok: `OK${s},Ravi,9876543210,H1,${Z.toLowerCase()},${W},28.401,77.301,${route.route_code.toLowerCase()}`,
      missingPid: `,x,,,${Z},${W},28.4,77.3,`,
      badZone: `BZ${s},,,,NOPE,${W},28.4,77.3,`,
      badWard: `BW${s},,,,${Z},NOWARD,28.4,77.3,`,
      halfCoord: `HC${s},,,,${Z},${W},28.4,,`,
      nonNumeric: `NN${s},,,,${Z},${W},abc,77.3,`,
      outOfRange: `OR${s},,,,${Z},${W},95,77.3,`,
      dupA: `DUP${s},,,,${Z},${W},28.402,77.302,`,
      dupB: `dup${s},,,,${Z},${W},28.403,77.303,`,
      badRoute: `BR${s},,,,${Z},${W},28.404,77.304,NOROUTE`,
      wrongRoute: `WR${s},,,,${Z},${W},28.405,77.305,${foreignRoute.route_code}`,
      outside: `OUT${s},,,,${Z},${W},51.5,-0.12,`,
      swapped: `SW${s},,,,${Z},${W},77.306,28.406,`,
      noCoords: `NC${s},,,,${Z},${W},,,`,
      samePairA: `SPA${s},,,,${Z},${W},28.41,77.41,`,
      samePairB: `SPB${s},,,,${Z},${W},28.41,77.41,`,
      sameAsDb: `SDB${s},,,,${Z},${W},28.31,77.31,`,
      existing: `${existing.pid_number},,,,${Z},${W},28.42,77.42,`,
    };
    const res = await upload(csv(Object.values(rows)), 'pids.csv', 'mode=validate');
    expect(res.status).toBe(200);
    const { summary } = res.body.data;
    expect(summary).toMatchObject({ total: 18, errors: 10, duplicates_in_file: 2, existing_in_db: 1 });
    expect(summary.valid).toBe(8);

    const err = (pid, field) => findingsFor(res.body, pid).some((f) => f.level === 'error' && f.field === field);
    const warn = (pid, re) => findingsFor(res.body, pid).some((f) => f.level === 'warning' && re.test(f.message));
    expect(res.body.data.findings.some((f) => f.row === 3 && f.field === 'pid_number' && f.level === 'error')).toBe(true);
    expect(err(`BZ${s}`, 'zone_code')).toBe(true);
    expect(err(`BW${s}`, 'ward_number')).toBe(true);
    expect(err(`HC${s}`, 'longitude')).toBe(true);
    expect(err(`NN${s}`, 'latitude')).toBe(true);
    expect(err(`OR${s}`, 'latitude')).toBe(true);
    expect(findingsFor(res.body, `DUP${s}`).filter((f) => f.level === 'error')).toHaveLength(2); // both occurrences
    expect(err(`BR${s}`, 'route_code')).toBe(true);
    expect(err(`WR${s}`, 'route_code')).toBe(true);
    expect(warn(`OUT${s}`, /outside the configured service area/)).toBe(true);
    expect(warn(`SW${s}`, /swapped/)).toBe(true);
    expect(warn(`NC${s}`, /Missing coordinates/)).toBe(true);
    expect(warn(`SPA${s}`, new RegExp(`SPB${s}`))).toBe(true);
    expect(warn(`SDB${s}`, new RegExp(existing.pid_number))).toBe(true);
    expect(findingsFor(res.body, `OK${s}`)).toEqual([]);

    const written = await pool.query('SELECT count(*)::int AS n FROM pids WHERE pid_number LIKE $1', [`%${s}`]);
    expect(written.rows[0].n).toBe(0);
  });

  it('returns the full report as CSV with report=csv', async () => {
    const res = await upload(csv([`,,,,X,1,,,`]), 'a.csv', 'mode=validate&report=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\r\n')[0]).toBe('row,pid_number,level,field,message');
    expect(res.text).toContain('PID number is required');
  });

  it('validates XLSX the same way', async () => {
    const s = uid();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['pid_number', 'zone_code', 'ward_number', 'latitude', 'longitude']);
    ws.addRow([`X1${s}`, zw.zone.zone_code, zw.ward.ward_number, 28.43, 77.43]);
    ws.addRow([`X2${s}`, 'NOPE', zw.ward.ward_number, 28.44, 77.44]);
    ws.addRow([`X3${s}`, zw.zone.zone_code, zw.ward.ward_number, { formula: '28+0.45', result: 28.45 }, 77.45]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await upload(buf, 'pids.xlsx', 'mode=validate');
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({ total: 3, valid: 2, errors: 1 });
    expect(findingsFor(res.body, `X2${s}`)[0]).toMatchObject({ row: 3, field: 'zone_code', level: 'error' });
  });

  it('rejects bad file types, spoofed content, missing columns and too many rows', async () => {
    expect((await upload(Buffer.from('hello'), 'a.txt', 'mode=validate')).status).toBe(400);
    expect((await upload(Buffer.from('pid_number,zone_code,ward_number\n'), 'a.xlsx', 'mode=validate')).status).toBe(400); // not a zip
    expect((await upload(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]), 'a.csv', 'mode=validate')).status).toBe(400); // zip named .csv
    const missing = await upload(Buffer.from('pid_number,latitude\nA,1\n'), 'a.csv', 'mode=validate');
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/zone_code, ward_number/);
    expect((await request(app).post('/api/pids/import?mode=validate').set(bearer(admin.token))).status).toBe(400); // no file
    expect((await upload(csv([]), 'a.csv', 'mode=nope')).status).toBe(400);

    const big = [HEADER];
    for (let i = 0; i < 50_001; i++) big.push(`R${i},,,,Z,1,,,`);
    const tooMany = await upload(Buffer.from(big.join('\n')), 'big.csv', 'mode=validate');
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.message).toMatch(/maximum is 50000/);
  });

  it('serves CSV and XLSX templates', async () => {
    const c = await request(app).get('/api/pids/import-template?format=csv').set(bearer(admin.token));
    expect(c.text.trim()).toBe('pid_number,owner_name,mobile,address,zone_code,ward_number,latitude,longitude,route_code');
    const x = await request(app).get('/api/pids/import-template?format=xlsx').set(bearer(admin.token)).buffer(true)
      .parse((r, cb) => { const chunks = []; r.on('data', (d) => chunks.push(d)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(x.headers['content-type']).toMatch(/spreadsheetml/);
    expect(x.body.subarray(0, 2).toString()).toBe('PK');
  });
});

describe('PID import — commit mode', () => {
  it('skip: inserts valid rows, skips existing and error rows, links routes, logs once', async () => {
    const s = uid();
    const Z = zw.zone.zone_code;
    const W = zw.ward.ward_number;
    const lines = [
      `C1${s},Owner,,Addr 1,${Z},${W},28.451,77.451,${route.route_code}`,
      `C2${s},,,,${Z},${W},,,`,
      `${existing.pid_number},Changed,,,${Z},${W},28.46,77.46,`,
      `BAD${s},,,,NOPE,${W},,,`,
    ];
    const res = await upload(csv(lines), 'commit.csv', 'mode=commit&on_existing=skip');
    expect(res.status).toBe(200);
    expect(res.body.data.result).toEqual({ inserted: 2, updated: 0, skipped_existing: 1, route_links: 1 });

    const rows = (await pool.query('SELECT pid_number, coord_status, latitude, owner_name FROM pids WHERE pid_number = ANY($1) ORDER BY pid_number',
      [[`C1${s}`, `C2${s}`, existing.pid_number]])).rows;
    expect(rows.find((r) => r.pid_number === `C1${s}`)).toMatchObject({ coord_status: 'IMPORTED', latitude: 28.451, owner_name: 'Owner' });
    expect(rows.find((r) => r.pid_number === `C2${s}`)).toMatchObject({ coord_status: 'MISSING', latitude: null });
    expect(rows.find((r) => r.pid_number === existing.pid_number).owner_name).toBeNull(); // untouched
    const link = await pool.query('SELECT 1 FROM route_pids rp JOIN pids p ON p.id = rp.pid_id WHERE rp.route_id = $1 AND p.pid_number = $2', [route.id, `C1${s}`]);
    expect(link.rowCount).toBe(1);
    const log = await pool.query("SELECT details FROM activity_logs WHERE action = 'IMPORT' AND details->>'filename' = 'commit.csv'");
    expect(log.rowCount).toBe(1);
    expect(log.rows[0].details).toMatchObject({ inserted: 2, skipped_existing: 1, rows_with_errors: 1 });
  });

  it('update: overwrites provided values, keeps manual coordinates and keeps coords when file has none', async () => {
    const Z = zw.zone.zone_code;
    const W = zw.ward.ward_number;
    const keepCoords = await createPid({ zone_id: zw.zone.id, ward_id: zw.ward.id, latitude: 28.33, longitude: 77.33 });
    const lines = [
      `${existing.pid_number},New Owner,,,${Z},${W},28.47,77.47,`,
      `${manual.pid_number},M Owner,,,${Z},${W},28.48,77.48,`,
      `${keepCoords.pid_number},K Owner,,,${Z},${W},,,`,
    ];
    const validate = await upload(csv(lines), 'u.csv', 'mode=validate&on_existing=update');
    expect(findingsFor(validate.body, manual.pid_number).some((f) => /will be kept/.test(f.message))).toBe(true);

    const res = await upload(csv(lines), 'u.csv', 'mode=commit&on_existing=update');
    expect(res.body.data.result).toMatchObject({ inserted: 0, updated: 3, skipped_existing: 0 });
    const byNum = Object.fromEntries((await pool.query('SELECT pid_number, owner_name, latitude, coord_status FROM pids WHERE id = ANY($1)',
      [[existing.id, manual.id, keepCoords.id]])).rows.map((r) => [r.pid_number, r]));
    expect(byNum[existing.pid_number]).toMatchObject({ owner_name: 'New Owner', latitude: 28.47, coord_status: 'IMPORTED' });
    expect(byNum[manual.pid_number]).toMatchObject({ owner_name: 'M Owner', latitude: 28.32, coord_status: 'MANUALLY_CORRECTED' });
    expect(byNum[keepCoords.pid_number]).toMatchObject({ owner_name: 'K Owner', latitude: 28.33, coord_status: 'IMPORTED' });
  });

  it('commits nothing when every row is invalid (still 200 with zero counts)', async () => {
    const res = await upload(csv([',,,,X,1,,,']), 'none.csv', 'mode=commit');
    expect(res.status).toBe(200);
    expect(res.body.data.result).toEqual({ inserted: 0, updated: 0, skipped_existing: 0, route_links: 0 });
  });
});
