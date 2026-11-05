// GUIDE #10 C/E7: daily archive — finalized-day wait, idempotency, retention, path traversal, permissions.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/config/database.js';
import { ARCHIVE_TYPES, reportsDir, runDailyArchive, safeArchivePath } from '../../src/services/reports/archiveService.js';
import { createUser, bearer } from '../helpers/fixtures.js';
import { makeAssignment, ist } from '../helpers/detection.js';

const OP = '2035-06-10'; // finalized day
const OP2 = '2035-06-20'; // day with an open assignment
const silent = { info() {}, warn() {}, error() {} };
const dir = reportsDir();
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
let app;

beforeAll(async () => {
  app = createApp();
  const a = await makeAssignment({ pids: [[28.5, 77.2], [28.6, 77.2]], date: OP });
  await pool.query("UPDATE route_assignments SET status = 'COMPLETED', finalized_at = now() WHERE id = $1", [a.raId]);
  await pool.query("UPDATE pid_daily_status SET visit_status = 'GPS_VISIT_CONFIRMED' WHERE route_assignment_id = $1 AND pid_id = $2", [a.raId, a.pidIds[0]]);
  await makeAssignment({ pids: [[28.5, 77.2]], date: OP2 }); // stays PLANNED, not finalized
});

describe('runDailyArchive', () => {
  it('waits for the configured time, then generates the 5 XLSX reports for the previous day; idempotent', async () => {
    expect((await runDailyArchive({ now: ist('2035-06-11', '05:59:00'), logger: silent })).status).toBe('before_time');

    const r = await runDailyArchive({ now: ist('2035-06-11', '06:05:00'), logger: silent });
    expect(r).toMatchObject({ status: 'done', operational_date: OP, finalized: true });
    expect(r.results.map((x) => [x.type, x.status])).toEqual(ARCHIVE_TYPES.map((t) => [t, 'SUCCESS']));
    const runs = (await pool.query("SELECT report_type, file_path, size_bytes, row_count, status, finalized FROM report_runs WHERE operational_date = $1 ORDER BY report_type", [OP])).rows;
    expect(runs).toHaveLength(5);
    for (const run of runs) {
      expect(run).toMatchObject({ status: 'SUCCESS', finalized: true });
      expect(run.file_path).toBe(`2035/06/${run.report_type}_${OP}.xlsx`);
      const abs = path.join(dir, run.file_path);
      expect(fs.statSync(abs).size).toBe(Number(run.size_bytes));
      expect(fs.existsSync(`${abs}.partial`)).toBe(false);
    }
    expect(runs.find((x) => x.report_type === 'daily-coverage').row_count).toBe(2);
    expect(runs.find((x) => x.report_type === 'missed-pids').row_count).toBe(1);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(dir, `2035/06/daily-coverage_${OP}.xlsx`));
    expect(wb.getWorksheet('Report').rowCount).toBe(3);
    expect(wb.getWorksheet('About').getSheetValues().some((row) => row?.[2] === 'system (daily archive)')).toBe(true);

    const again = await runDailyArchive({ now: ist('2035-06-11', '07:00:00'), logger: silent });
    expect(again.status).toBe('up_to_date');
    expect((await pool.query('SELECT count(*)::int n FROM report_runs WHERE operational_date = $1', [OP])).rows[0].n).toBe(5);
  });

  it('day not finalized: waits (retry) until REPORTS_WAIT_UNTIL, then generates and marks finalized=false', async () => {
    const w = await runDailyArchive({ now: ist('2035-06-21', '08:00:00'), waitUntil: '12:00', logger: silent });
    expect(w).toMatchObject({ status: 'waiting', operational_date: OP2, open_assignments: 1 });
    expect((await pool.query('SELECT count(*)::int n FROM report_runs WHERE operational_date = $1', [OP2])).rows[0].n).toBe(0);
    const g = await runDailyArchive({ now: ist('2035-06-21', '12:01:00'), waitUntil: '12:00', logger: silent });
    expect(g).toMatchObject({ status: 'done', finalized: false });
    const flags = (await pool.query('SELECT DISTINCT finalized FROM report_runs WHERE operational_date = $1', [OP2])).rows;
    expect(flags).toEqual([{ finalized: false }]);
  });

  it('a "not finalized" day is regenerated once finalized: new file, row swapped, old file deleted; finalized rows untouched', async () => {
    const before = (await pool.query('SELECT id, report_type, file_path FROM report_runs WHERE operational_date = $1 ORDER BY report_type', [OP2])).rows;
    const okBefore = (await pool.query('SELECT id, file_path, finished_at FROM report_runs WHERE operational_date = $1 ORDER BY id', [OP])).rows;
    // still open: nothing regenerated
    expect((await runDailyArchive({ now: ist('2035-06-21', '12:30:00'), logger: silent })).regenerated).toEqual([]);
    await pool.query("UPDATE route_assignments SET status = 'COMPLETED', finalized_at = now() WHERE operational_date = $1", [OP2]);
    const r = await runDailyArchive({ now: ist('2035-06-21', '15:00:00'), logger: silent });
    expect(r.regenerated.map((x) => x.type).sort()).toEqual([...ARCHIVE_TYPES].sort());
    const after = (await pool.query('SELECT id, report_type, file_path, finalized, status FROM report_runs WHERE operational_date = $1 ORDER BY report_type', [OP2])).rows;
    expect(after.map((x) => x.id)).toEqual(before.map((x) => x.id)); // same rows, swapped in place (no duplicates)
    for (const [i, row] of after.entries()) {
      expect(row).toMatchObject({ finalized: true, status: 'SUCCESS', file_path: `2035/06/${row.report_type}_${OP2}_final.xlsx` });
      expect(fs.existsSync(path.join(dir, row.file_path))).toBe(true);
      expect(fs.existsSync(path.join(dir, before[i].file_path))).toBe(false); // superseded file removed
    }
    expect((await pool.query('SELECT id, file_path, finished_at FROM report_runs WHERE operational_date = $1 ORDER BY id', [OP])).rows).toEqual(okBefore);
    expect((await runDailyArchive({ now: ist('2035-06-21', '16:00:00'), logger: silent })).regenerated).toEqual([]); // idempotent
  });

  it('retention deletes old runs and their files (only inside REPORTS_DIR)', async () => {
    const rel = '2035/01/ward-wise_2035-01-01.xlsx';
    fs.mkdirSync(path.join(dir, '2035/01'), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), 'old');
    await pool.query("INSERT INTO report_runs (report_type, operational_date, format, file_path, status) VALUES ('ward-wise', '2035-01-01', 'xlsx', $1, 'SUCCESS')", [rel]);
    const r = await runDailyArchive({ now: ist('2035-06-21', '13:00:00'), retentionDays: 90, logger: silent });
    expect(r.retention).toMatchObject({ cutoff: '2035-03-23', runs_deleted: 1, files_deleted: 1 });
    expect(fs.existsSync(path.join(dir, rel))).toBe(false);
  });
});

describe('archive API', () => {
  it('lists and downloads (SUPER_ADMIN / DEPARTMENT_ADMIN only); other roles 403', async () => {
    const dept = await createUser('DEPARTMENT_ADMIN');
    const list = await request(app).get(`/api/reports/archive?from=${OP}&to=${OP}&type=daily-coverage`).set(bearer(dept.token));
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([expect.objectContaining({ report_type: 'daily-coverage', operational_date: OP, status: 'SUCCESS', row_count: 2, finalized: true })]);
    expect(list.body.data[0]).not.toHaveProperty('file_path'); // server paths are never exposed
    const id = list.body.data[0].id;
    const dl = await request(app).get(`/api/reports/archive/${id}/download`).set(bearer(dept.token)).buffer(true).parse(binary);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="daily-coverage_${OP}_all.xlsx"`);
    expect(dl.headers['cache-control']).toBe('no-store');
    expect(dl.body.subarray(0, 2).toString()).toBe('PK'); // zip container
    for (const role of ['ZONE_ADMIN', 'WARD_SUPERVISOR', 'AGENCY_USER']) {
      const u = await createUser(role); // eslint-disable-line no-await-in-loop
      expect((await request(app).get('/api/reports/archive').set(bearer(u.token))).status).toBe(403); // eslint-disable-line no-await-in-loop
      expect((await request(app).get(`/api/reports/archive/${id}/download`).set(bearer(u.token))).status).toBe(403); // eslint-disable-line no-await-in-loop
    }
  });

  it('path traversal: a stored ../ path or absolute path is never served; bad ids are 400', async () => {
    const admin = await createUser('SUPER_ADMIN');
    const evil = await pool.query(
      `INSERT INTO report_runs (report_type, operational_date, format, file_path, status) VALUES
         ('agency-wise', '2035-06-25', 'xlsx', '../../../../etc/passwd', 'SUCCESS'),
         ('ward-wise', '2035-06-25', 'xlsx', $1, 'SUCCESS') RETURNING id`, [path.resolve('package.json')]);
    for (const { id } of evil.rows) {
      expect((await request(app).get(`/api/reports/archive/${id}/download`).set(bearer(admin.token))).status).toBe(404); // eslint-disable-line no-await-in-loop
    }
    expect((await request(app).get('/api/reports/archive/..%2F..%2Fetc%2Fpasswd/download').set(bearer(admin.token))).status).toBe(400);
    expect((await request(app).get('/api/reports/archive/abc/download').set(bearer(admin.token))).status).toBe(400);
    expect(safeArchivePath('../x', dir)).toBeNull();
    expect(safeArchivePath('2035/../../x', dir)).toBeNull();
    expect(safeArchivePath(path.resolve('/etc/passwd'), dir)).toBeNull();
    expect(safeArchivePath('', dir)).toBeNull();
    expect(safeArchivePath('2035/06/a.xlsx', dir)).toBe(path.join(dir, '2035', '06', 'a.xlsx'));
  });
});
