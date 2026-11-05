// Cell formatting shared by the writers (GUIDE #10 B).
import { env } from '../../config/env.js';

const istParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: env.APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Timestamp -> "YYYY-MM-DD HH:mm" in the operational timezone (IST). */
export function istDateTime(v) {
  if (v === null || v === undefined || v === '') return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(istParts.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Typed value for XLSX (numbers stay numbers) / display string for CSV & PDF. */
export function cellValue(type, v) {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'datetime': return istDateTime(v);
    case 'int': case 'float': case 'pct': case 'coord': {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    default: return String(v);
  }
}

export function displayValue(type, v) {
  const c = cellValue(type, v);
  if (c === null || c === undefined) return '';
  if (type === 'pct') return `${c.toFixed(1)}%`;
  if (type === 'float') return String(Math.round(c * 10) / 10);
  return String(c);
}

/** CSV-injection guard (OWASP): text cells starting with = + - @ TAB CR get a leading apostrophe. */
export function guardFormula(s) {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** RFC 4180 field: quoted when it contains a quote, comma, CR or LF; quotes doubled. */
export function csvField(s) {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV value for a typed cell: numbers are written raw (never guarded: "-12.5" is data, not a formula). */
export function csvCell(type, v) {
  const c = cellValue(type, v);
  if (c === null || c === undefined) return '';
  if (typeof c === 'number') return String(c);
  return csvField(guardFormula(c));
}

/** Safe download filename: <report>_<date-or-range>_<scope>.<ext> */
export function exportFilename(report, q, scopeLabel, ext) {
  const range = q.from === q.to ? q.from : `${q.from}_to_${q.to}`;
  const raw = `${report}_${range || 'track'}_${scopeLabel}.${ext}`;
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 150);
}

export function scopeLabel(scope) {
  if (!scope || scope.unrestricted) return 'all';
  if (scope.role_key === 'ZONE_ADMIN') return `zone-${scope.zone_id}`;
  if (scope.role_key === 'WARD_SUPERVISOR') return `ward-${scope.ward_id}`;
  if (scope.role_key === 'AGENCY_USER') return `agency-${scope.agency_id}`;
  return 'scoped';
}
