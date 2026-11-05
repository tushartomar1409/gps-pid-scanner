// Provider timestamp parsing. Naive timestamps (no Z / offset) are wall-clock times in the
// provider's timezone; date-fns-tz converts them — no hand-written offset arithmetic.
import { fromZonedTime } from 'date-fns-tz';

const NAIVE_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/;
const ZONED_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * @param {string|number|Date|null|undefined} value
 * @param {string} tz IANA zone for naive values (GPS_PROVIDER_TIMEZONE)
 * @returns {{ ok: Date } | { error: 'NO_TIMESTAMP' | 'BAD_TIMESTAMP' }}
 */
export function parseProviderTimestamp(value, tz) {
  if (value === null || value === undefined || value === '') return { error: 'NO_TIMESTAMP' };
  let d;
  if (value instanceof Date) d = new Date(value.getTime());
  else if (typeof value === 'number') d = new Date(value > 1e12 ? value : value * 1000); // epoch ms or s
  else if (typeof value === 'string') {
    const s = value.trim();
    if (/^\d{9,13}$/.test(s)) d = new Date(Number(s) > 1e12 ? Number(s) : Number(s) * 1000);
    // "+0530" -> "+05:30": JS Date only reliably parses the colon form.
    else if (ZONED_RE.test(s)) d = new Date(s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    else if (NAIVE_RE.test(s)) d = fromZonedTime(s.replace(' ', 'T'), tz);
    else return { error: 'BAD_TIMESTAMP' };
  } else return { error: 'BAD_TIMESTAMP' };
  return Number.isNaN(d.getTime()) ? { error: 'BAD_TIMESTAMP' } : { ok: d };
}
