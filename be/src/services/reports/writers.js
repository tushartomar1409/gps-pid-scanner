// Streaming writers (GUIDE #10 B): rows are written as they arrive; nothing builds the whole file in memory.
// Interface: const w = createWriter(format, out, def, meta); await w.row(record) ...; await w.finish(about)
import ExcelJS from 'exceljs';
import { cellValue, csvCell, csvField } from './format.js';
import { createPdfWriter } from './pdfWriter.js';

export const CONTENT_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
};

/** Write with backpressure: resolves when the destination can take more. */
function writeAsync(out, chunk) {
  if (out.write(chunk)) return null;
  return new Promise((resolve, reject) => {
    const onDrain = () => { cleanup(); resolve(); };
    const onErr = (e) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error('destination closed')); };
    const cleanup = () => { out.off('drain', onDrain); out.off('error', onErr); out.off('close', onClose); };
    out.on('drain', onDrain);
    out.on('error', onErr);
    out.on('close', onClose);
  });
}

function waitDrain(out) {
  return new Promise((resolve, reject) => {
    const done = (err) => { out.off('drain', ok); out.off('error', done); out.off('close', closed); if (err) reject(err); else resolve(); };
    const ok = () => done();
    const closed = () => done(new Error('destination closed'));
    out.on('drain', ok);
    out.on('error', done);
    out.on('close', closed);
  });
}

function endAsync(out, chunk) {
  return new Promise((resolve, reject) => {
    out.once('error', reject);
    out.end(chunk, resolve);
  });
}

export const BOM = String.fromCharCode(0xfeff); // UTF-8 BOM: Excel then opens UTF-8 (Hindi) correctly

function createCsvWriter(out, def) {
  let headerDone = false;
  const header = () => `${BOM}${def.columns.map((c) => csvField(c.header)).join(',')}\r\n`;
  return {
    async row(rec) {
      const line = `${headerDone ? '' : header()}${def.columns.map((c) => csvCell(c.type, rec[c.key])).join(',')}\r\n`;
      headerDone = true;
      await writeAsync(out, line);
    },
    async finish() {
      await endAsync(out, headerDone ? '' : header());
    },
  };
}

const PCT_FMT = '0.0"%"';

function createXlsxWriter(out, def, meta) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
  wb.creator = 'GPS PID Portal';
  wb.created = meta.generatedAt;
  const ws = wb.addWorksheet('Report', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = def.columns.map((c) => ({
    header: c.header, key: c.key, width: c.width,
    style: c.type === 'pct' ? { numFmt: PCT_FMT } : c.type === 'coord' ? { numFmt: '0.000000' } : undefined,
  }));
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: def.columns.length } };
  let pending = 0;
  return {
    async row(rec) {
      ws.addRow(def.columns.map((c) => cellValue(c.type, rec[c.key]))).commit();
      // Backpressure: ExcelJS -> zip -> out does not pause the producer by itself. Every 200 rows yield, and
      // if the destination (socket/file) is full wait for 'drain', so a slow client never makes rows pile up.
      if (++pending % 200 === 0) {
        await new Promise((r) => setImmediate(r));
        if (out.writableNeedDrain) await waitDrain(out);
      }
    },
    async finish(about) {
      ws.commit();
      const a = wb.addWorksheet('About');
      a.columns = [{ header: 'Field', key: 'k', width: 28 }, { header: 'Value', key: 'v', width: 100 }];
      a.getRow(1).font = { bold: true };
      for (const [k, v] of about) a.addRow({ k, v: v === null || v === undefined ? '' : String(v) }).commit();
      a.commit();
      await wb.commit();
    },
  };
}

export function createWriter(format, out, def, meta) {
  if (format === 'csv') return createCsvWriter(out, def, meta);
  if (format === 'xlsx') return createXlsxWriter(out, def, meta);
  if (format === 'pdf') return createPdfWriter(out, def, meta);
  throw new Error(`Unknown format ${format}`);
}
