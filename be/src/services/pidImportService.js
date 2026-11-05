// PID bulk import (GUIDE #4 B): parse CSV/XLSX -> validate (dry run) -> commit in one transaction.
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { env } from '../config/env.js';
import { db as defaultDb, withTransaction } from '../config/database.js';
import { getServiceAreaBbox } from './settingsService.js';
import { recordActivity } from './activityLogService.js';
import { badRequest, unprocessable } from '../utils/errors.js';
import { bboxWarning, isLat, isLng, round7 } from '../utils/geo.js';
import { PID_NUMBER_RE, MOBILE_RE } from '../validators/pidValidators.js';

export const IMPORT_COLUMNS = ['pid_number', 'owner_name', 'mobile', 'address', 'zone_code', 'ward_number', 'latitude', 'longitude', 'route_code'];
const REQUIRED_COLUMNS = ['pid_number', 'zone_code', 'ward_number'];
export const INLINE_FINDINGS_LIMIT = 1000;
const CHUNK = 500;

// ---------------------------------------------------------------- parsing

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Returns { headers: string[], rows: [{ row, cells: string[] }] }. Throws 400/422 on bad input. */
export async function parseUpload(file, { maxRows = env.IMPORT_MAX_ROWS } = {}) {
  if (!file?.buffer?.length) throw badRequest('Upload a non-empty .csv or .xlsx file in the "file" field');
  const ext = path.extname(file.originalname || '').toLowerCase();
  const isZip = file.buffer.subarray(0, 4).equals(ZIP_MAGIC);
  const looksBinary = file.buffer.subarray(0, 8192).includes(0);

  let table;
  if (ext === '.xlsx') {
    if (!isZip) throw badRequest('File content is not a valid .xlsx workbook');
    table = await readXlsx(file.buffer, maxRows);
  } else if (ext === '.csv') {
    if (isZip || looksBinary) throw badRequest('File content is not a text CSV file');
    table = readCsv(file.buffer, maxRows);
  } else {
    throw badRequest('Only .csv and .xlsx files are accepted');
  }

  const [headerRow, ...dataRows] = table;
  if (!headerRow) throw badRequest('The file is empty');
  const headers = headerRow.cells.map((h) => String(h ?? '').trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length) throw badRequest(`Missing required column(s): ${missing.join(', ')}`, missing.map((c) => ({ field: c, message: 'Required column' })));

  const rows = dataRows.filter((r) => r.cells.some((c) => String(c ?? '').trim() !== ''));
  if (rows.length > maxRows) throw unprocessable(`File has ${rows.length} data rows; the maximum is ${maxRows}`);
  return { headers, rows };
}

function readCsv(buffer, maxRows) {
  let records;
  try {
    records = parseCsv(buffer, { bom: true, relax_column_count: true, skip_empty_lines: false, trim: true });
  } catch (err) {
    throw badRequest(`Could not parse CSV: ${err.message}`);
  }
  // +1 header, +small slack for blank lines; precise check happens after blank-row filtering.
  if (records.length > maxRows * 2 + 1) throw unprocessable(`File has more than ${maxRows} data rows`);
  return records.map((cells, i) => ({ row: i + 1, cells }));
}

async function readXlsx(buffer, maxRows) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw badRequest('Could not read the .xlsx workbook');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw badRequest('The workbook has no worksheets');
  if (ws.actualRowCount > maxRows + 1) throw unprocessable(`File has ${ws.actualRowCount - 1} data rows; the maximum is ${maxRows}`);
  const out = [];
  ws.eachRow({ includeEmpty: false }, (r, rowNumber) => {
    const values = Array.isArray(r.values) ? r.values.slice(1) : [];
    out.push({ row: rowNumber, cells: values.map(cellToString) });
  });
  return out;
}

function cellToString(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v) return cellToString(v.result); // formula
    if ('text' in v) return String(v.text); // hyperlink
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    return '';
  }
  return String(v).trim();
}

// ---------------------------------------------------------------- validation

const MAX_LEN = { owner_name: 150, address: 500 };

function parseCoord(raw) {
  if (raw === '') return { empty: true };
  const n = Number(raw);
  return Number.isFinite(n) ? { value: n } : { invalid: true };
}

/**
 * Validates parsed rows against the DB. Pure read-only.
 * Returns { records (valid rows, normalised), findings, summary }.
 */
export async function validateRows({ headers, rows }, { onExisting = 'skip', executor = defaultDb } = {}) {
  const idx = Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, headers.indexOf(c)]));
  const get = (cells, col) => (idx[col] >= 0 ? String(cells[idx[col]] ?? '').trim() : '');
  const findings = [];
  const add = (rec, level, field, message) => {
    findings.push({ row: rec.row, pid_number: rec.pid_number || null, level, field, message });
    if (level === 'error') rec.hasError = true;
    else rec.hasWarning = true;
  };

  // 1. Shape + per-field parsing
  const recs = rows.map(({ row, cells }) => {
    const rec = {
      row,
      pid_number: get(cells, 'pid_number').toUpperCase(),
      owner_name: get(cells, 'owner_name') || null,
      mobile: get(cells, 'mobile') || null,
      address: get(cells, 'address') || null,
      zone_code: get(cells, 'zone_code').toUpperCase(),
      ward_number: get(cells, 'ward_number'),
      route_code: get(cells, 'route_code').toUpperCase() || null,
      latitude: null,
      longitude: null,
    };
    if (!rec.pid_number) add(rec, 'error', 'pid_number', 'PID number is required');
    else if (!PID_NUMBER_RE.test(rec.pid_number)) add(rec, 'error', 'pid_number', 'PID number must be 1–50 chars: letters, digits, / _ . -');
    if (!rec.zone_code) add(rec, 'error', 'zone_code', 'Zone code is required');
    if (!rec.ward_number) add(rec, 'error', 'ward_number', 'Ward number is required');
    for (const [f, max] of Object.entries(MAX_LEN)) {
      if (rec[f] && rec[f].length > max) add(rec, 'error', f, `Must be at most ${max} characters`);
    }
    if (rec.mobile && !MOBILE_RE.test(rec.mobile)) {
      add(rec, 'warning', 'mobile', 'Mobile number is not valid and will be left empty');
      rec.mobile = null;
    }

    const lat = parseCoord(get(cells, 'latitude'));
    const lng = parseCoord(get(cells, 'longitude'));
    if (lat.empty !== lng.empty) {
      add(rec, 'error', lat.empty ? 'latitude' : 'longitude', 'Provide both latitude and longitude, or neither');
    } else if (!lat.empty) {
      const latOk = !lat.invalid && isLat(lat.value);
      const lngOk = !lng.invalid && isLng(lng.value);
      if (!latOk) add(rec, 'error', 'latitude', 'Latitude must be a number between -90 and 90');
      if (!lngOk) add(rec, 'error', 'longitude', 'Longitude must be a number between -180 and 180');
      if (latOk && lngOk) {
        rec.latitude = round7(lat.value);
        rec.longitude = round7(lng.value);
      }
    }
    return rec;
  });

  // 2. Duplicate pid_number within the file — flag every occurrence.
  const byNumber = new Map();
  for (const r of recs) if (r.pid_number) byNumber.set(r.pid_number, [...(byNumber.get(r.pid_number) || []), r]);
  let duplicatesInFile = 0;
  for (const [num, list] of byNumber) {
    if (list.length < 2) continue;
    duplicatesInFile += list.length;
    const rowsList = list.map((r) => r.row).join(', ');
    for (const r of list) add(r, 'error', 'pid_number', `PID ${num} appears ${list.length} times in the file (rows ${rowsList})`);
  }

  // 3. Reference data lookups (small tables loaded whole; routes/PIDs by the values in the file).
  const [zonesRes, wardsRes] = await Promise.all([
    executor.query('SELECT id, upper(zone_code) AS code FROM zones'),
    executor.query('SELECT id, zone_id, ward_number FROM wards'),
  ]);
  const zones = new Map(zonesRes.rows.map((z) => [z.code, z.id]));
  const wards = new Map(wardsRes.rows.map((w) => [`${w.zone_id}|${String(w.ward_number).trim().toLowerCase()}`, w]));

  const routeCodes = [...new Set(recs.map((r) => r.route_code).filter(Boolean))];
  const routes = new Map();
  if (routeCodes.length) {
    const { rows: rr } = await executor.query(
      'SELECT id, upper(route_code) AS code, zone_id, ward_id FROM routes WHERE upper(route_code) = ANY($1::text[])', [routeCodes]);
    for (const r of rr) routes.set(r.code, r);
  }

  const numbers = [...byNumber.keys()];
  const existing = new Map();
  if (numbers.length) {
    const { rows: er } = await executor.query(
      `SELECT p.id, p.pid_number, p.ward_id, p.coord_status,
              COALESCE((SELECT array_agg(DISTINCT r.ward_id) FROM route_pids rp JOIN routes r ON r.id = rp.route_id
                         WHERE rp.pid_id = p.id), '{}') AS route_wards
         FROM pids p WHERE p.pid_number = ANY($1::text[])`, [numbers]);
    for (const e of er) existing.set(e.pid_number, e);
  }

  // 4. Cross-reference checks
  for (const r of recs) {
    if (r.zone_code) {
      r.zone_id = zones.get(r.zone_code);
      if (!r.zone_id) add(r, 'error', 'zone_code', `Unknown zone code ${r.zone_code}`);
      else if (r.ward_number) {
        const w = wards.get(`${r.zone_id}|${r.ward_number.toLowerCase()}`);
        if (!w) add(r, 'error', 'ward_number', `Ward ${r.ward_number} does not exist in zone ${r.zone_code}`);
        else r.ward_id = w.id;
      }
    }
    if (r.route_code) {
      const route = routes.get(r.route_code);
      if (!route) add(r, 'error', 'route_code', `Unknown route code ${r.route_code}`);
      else if (r.ward_id && (route.ward_id !== r.ward_id || route.zone_id !== r.zone_id)) {
        add(r, 'error', 'route_code', `Route ${r.route_code} belongs to a different zone/ward than this PID`);
      } else r.route_id = route.id;
    }
    const ex = existing.get(r.pid_number);
    if (ex) {
      r.existing = ex;
      if (onExisting === 'update' && r.ward_id && ex.ward_id !== r.ward_id && ex.route_wards.some((w) => w !== r.ward_id)) {
        add(r, 'error', 'ward_number', 'Existing PID is on routes in its current ward; cannot move it to another ward via import');
      }
      if (onExisting === 'update' && r.latitude !== null && ['MANUALLY_CORRECTED', 'VERIFIED'].includes(ex.coord_status)) {
        add(r, 'warning', 'latitude', `Existing PID has ${ex.coord_status} coordinates; they will be kept, file coordinates ignored`);
      }
    }
  }

  // 5. Coordinate warnings: missing, service area / swapped, duplicate pair (file + DB).
  const bbox = await getServiceAreaBbox(executor);
  const pairKey = (r) => `${r.latitude}|${r.longitude}`;
  const byPair = new Map();
  for (const r of recs) {
    if (r.latitude === null) {
      if (!r.hasError) add(r, 'warning', 'latitude', 'Missing coordinates — PID will be imported with coord_status MISSING');
      continue;
    }
    const w = bboxWarning(r.latitude, r.longitude, bbox);
    if (w) add(r, 'warning', 'latitude', w.message);
    byPair.set(pairKey(r), [...(byPair.get(pairKey(r)) || []), r]);
  }
  for (const list of byPair.values()) {
    const distinct = new Set(list.map((r) => r.pid_number));
    if (distinct.size < 2) continue;
    for (const r of list) {
      const others = list.filter((o) => o.pid_number !== r.pid_number).map((o) => `${o.pid_number} (row ${o.row})`).join(', ');
      add(r, 'warning', 'latitude', `Same coordinates as ${others} in this file`);
    }
  }
  const pairs = [...byPair.values()].map((l) => l[0]);
  if (pairs.length) {
    const { rows: dup } = await executor.query(
      `SELECT c.lat, c.lng, array_agg(p.pid_number ORDER BY p.pid_number) AS pid_numbers
         FROM unnest($1::numeric[], $2::numeric[]) AS c(lat, lng)
         JOIN pids p ON p.latitude = c.lat AND p.longitude = c.lng
        GROUP BY c.lat, c.lng`,
      [pairs.map((r) => r.latitude), pairs.map((r) => r.longitude)],
    );
    for (const d of dup) {
      for (const r of byPair.get(`${d.lat}|${d.lng}`) || []) {
        const others = d.pid_numbers.filter((n) => n !== r.pid_number);
        if (others.length) add(r, 'warning', 'latitude', `Same coordinates as existing PID(s) ${others.slice(0, 5).join(', ')}${others.length > 5 ? '…' : ''}`);
      }
    }
  }

  findings.sort((a, b) => a.row - b.row || (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  const records = recs.filter((r) => !r.hasError);
  const summary = {
    total: recs.length,
    valid: records.length,
    errors: recs.filter((r) => r.hasError).length,
    warnings: recs.filter((r) => r.hasWarning).length,
    duplicates_in_file: duplicatesInFile,
    existing_in_db: records.filter((r) => r.existing).length,
    findings_total: findings.length,
  };
  return { records, findings, summary };
}

// ---------------------------------------------------------------- commit

const INSERT_COLS = ['pid_number', 'owner_name', 'mobile', 'address', 'zone_id', 'ward_id', 'latitude', 'longitude', 'coord_status'];

const ON_CONFLICT = {
  skip: 'ON CONFLICT (pid_number) DO NOTHING',
  // Update overwrites only values present in the file; manually corrected / verified coordinates win.
  update: `ON CONFLICT (pid_number) DO UPDATE SET
      owner_name = COALESCE(EXCLUDED.owner_name, pids.owner_name),
      mobile     = COALESCE(EXCLUDED.mobile, pids.mobile),
      address    = COALESCE(EXCLUDED.address, pids.address),
      zone_id    = EXCLUDED.zone_id,
      ward_id    = EXCLUDED.ward_id,
      latitude   = CASE WHEN pids.coord_status IN ('MANUALLY_CORRECTED','VERIFIED') THEN pids.latitude
                        ELSE COALESCE(EXCLUDED.latitude, pids.latitude) END,
      longitude  = CASE WHEN pids.coord_status IN ('MANUALLY_CORRECTED','VERIFIED') THEN pids.longitude
                        ELSE COALESCE(EXCLUDED.longitude, pids.longitude) END,
      coord_status = CASE WHEN pids.coord_status IN ('MANUALLY_CORRECTED','VERIFIED') THEN pids.coord_status
                          WHEN EXCLUDED.latitude IS NOT NULL THEN 'IMPORTED' ELSE pids.coord_status END`,
};

export async function commitRecords(records, { onExisting, filename, summary, ctx }) {
  return withTransaction(async (tx) => {
    const counts = { inserted: 0, updated: 0, skipped_existing: 0, route_links: 0 };
    const idByNumber = new Map();

    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK);
      const values = [];
      const tuples = chunk.map((r) => {
        const row = { ...r, coord_status: r.latitude !== null ? 'IMPORTED' : 'MISSING' };
        const ph = INSERT_COLS.map((c) => {
          values.push(row[c] ?? null);
          return `$${values.length}`;
        });
        return `(${ph.join(', ')})`;
      });
      // eslint-disable-next-line no-await-in-loop -- chunks must run sequentially inside one transaction
      const { rows } = await tx.query(
        `INSERT INTO pids (${INSERT_COLS.join(', ')}) VALUES ${tuples.join(', ')} ${ON_CONFLICT[onExisting]}
         RETURNING id, pid_number, (xmax = 0) AS inserted`,
        values,
      );
      for (const r of rows) {
        idByNumber.set(r.pid_number, r.id);
        if (r.inserted) counts.inserted++;
        else counts.updated++;
      }
      counts.skipped_existing += chunk.length - rows.length;
    }

    const links = records.filter((r) => r.route_id && idByNumber.has(r.pid_number));
    if (links.length) {
      const res = await tx.query(
        `INSERT INTO route_pids (route_id, pid_id)
         SELECT * FROM unnest($1::int[], $2::bigint[]) ON CONFLICT DO NOTHING`,
        [links.map((r) => r.route_id), links.map((r) => idByNumber.get(r.pid_number))],
      );
      counts.route_links = res.rowCount;
    }

    await recordActivity(ctx, {
      action: 'IMPORT',
      module: 'pids',
      details: { filename, on_existing: onExisting, ...summary, ...counts, rows_with_errors: summary.errors },
    }, tx);
    return counts;
  });
}

// ---------------------------------------------------------------- report / templates

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function findingsToCsv(findings) {
  const lines = ['row,pid_number,level,field,message'];
  for (const f of findings) lines.push([f.row, f.pid_number, f.level, f.field, f.message].map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export async function buildTemplate(format) {
  if (format === 'csv') return { body: Buffer.from(`${IMPORT_COLUMNS.join(',')}\r\n`), type: 'text/csv; charset=utf-8', ext: 'csv' };
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('PIDs');
  ws.addRow(IMPORT_COLUMNS);
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c) => { c.width = 16; });
  return {
    body: Buffer.from(await wb.xlsx.writeBuffer()),
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
  };
}
