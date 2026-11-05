// Report pages (flow §18 pages 12–17, GUIDE #10 D). Columns come from the server preview.
import { VISIT_STATUS, VISIT_STATUS_ORDER } from '../../utils/visitStatus.js';

const ALL = ['zone_id', 'ward_id', 'agency_id', 'vehicle_id', 'route_id'];

export const MISSED_REASONS = ['NOT_VISITED', 'GPS_DATA_UNAVAILABLE', 'GPS_VISIT_CANDIDATE'];

export const REPORT_PAGES = Object.freeze({
  'daily-coverage': {
    title: 'Daily PID Coverage', flow: '§14.1', filters: ALL,
    status: { label: 'Visit status', options: VISIT_STATUS_ORDER.map((k) => ({ value: k, label: VISIT_STATUS[k].label })) },
  },
  'vehicle-wise': { title: 'Vehicle-wise Report', flow: '§14.2', filters: ALL },
  'agency-wise': { title: 'Agency-wise Report', flow: '§14.3', filters: ALL },
  'ward-wise': { title: 'Ward-wise Report', flow: '§14.4', filters: ALL },
  'missed-pids': {
    title: 'Missed PIDs', flow: '§14.5', filters: ALL, chips: true,
    status: { label: 'Missed reason', options: MISSED_REASONS.map((k) => ({ value: k, label: VISIT_STATUS[k].label })) },
  },
});

export const REPORT_ORDER = ['daily-coverage', 'vehicle-wise', 'agency-wise', 'ward-wise', 'missed-pids'];

/** URL filter state -> API params (single day OR range; empty values dropped by cleanParams). */
export function toApiParams(f) {
  const { mode, date, from, to, ...rest } = f;
  const range = mode === 'range' ? { from, to } : { date };
  return { ...rest, ...range, page: Number(f.page) || 1, limit: 25 };
}

/** Export error -> user message (GUIDE #10 D3). */
export function exportErrorMessage(err) {
  const status = err?.response?.status;
  const msg = err?.response?.data?.message;
  if (status === 422) return `${msg || 'Too many rows for PDF.'} Tip: use the Excel export for large reports.`;
  if (status === 429) return msg || 'Export limit reached. Please wait a minute and try again.';
  if (status === 403) return 'You do not have permission to export reports.';
  if (!err?.response) return 'Unable to reach the server. Check your connection and try again.';
  return msg || `Export failed (${status})`;
}
