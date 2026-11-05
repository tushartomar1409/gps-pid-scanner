// Operational dates/times are in IST (Asia/Kolkata, fixed +05:30, no DST) — flow.txt §22.
export const OP_TZ = 'Asia/Kolkata';
export const OP_OFFSET = '+05:30';

/** Today's date (YYYY-MM-DD) in IST. */
export function todayIST(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: OP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDaysISO(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Builds shift ISO strings with an explicit +05:30 offset from an operational date and HH:mm times.
 * If end <= start, the shift ends on the next day (midnight-crossing). Returns null when both empty.
 */
export function buildShiftIso(date, startHHmm, endHHmm) {
  if (!startHHmm && !endHHmm) return null;
  if (!startHHmm || !endHHmm) return { error: 'Give both a start and an end time, or neither' };
  const crosses = endHHmm <= startHHmm;
  const endDate = crosses ? addDaysISO(date, 1) : date;
  return {
    shift_start: `${date}T${startHHmm}:00${OP_OFFSET}`,
    shift_end: `${endDate}T${endHHmm}:00${OP_OFFSET}`,
    crossesMidnight: crosses,
  };
}

const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: OP_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: OP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** "06:00–14:00", "20:00–04:00 (+1)" or "All day" for an assignment row, in IST. */
export function formatShift(row) {
  if (!row.shift_start) return 'All day';
  const s = new Date(row.shift_start);
  const e = new Date(row.shift_end);
  const nextDay = dayFmt.format(e) > row.operational_date ? ' (+1)' : '';
  return `${timeFmt.format(s)}–${timeFmt.format(e)}${nextDay}`;
}

const longDate = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', weekday: 'short' });
export const formatOpDate = (d) => (d ? longDate.format(new Date(`${d}T00:00:00Z`)) : '—');
