// GUIDE #10 E8: ReportPage filters -> query, export flow (blob + server filename), 422/429 messages, missed chips.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import ReportPage from '../pages/reports/ReportPage.jsx';
import { exportErrorMessage, toApiParams } from '../pages/reports/reportConfig.js';
import { reportsApi } from '../api/resources.js';
import { downloadBlob } from '../utils/download.js';

vi.mock('../api/resources.js', () => ({
  reportsApi: { preview: vi.fn(), export: vi.fn() },
  referenceApi: { lookups: vi.fn(() => Promise.resolve({ data: { zones: [{ id: 2, name: 'North' }], wards: [] } })) },
}));
vi.mock('../utils/download.js', () => ({ downloadBlob: vi.fn() }));
const perms = { list: ['*'] };
vi.mock('../auth/usePermission.js', () => ({
  usePermission: () => (p) => perms.list.includes('*') || perms.list.includes(p),
  hasPermission: () => true,
}));

const COLUMNS = [
  { key: 'pid_number', header: 'PID number', type: 'text' }, { key: 'address', header: 'Address', type: 'text' },
  { key: 'visit_status_label', header: 'Visit status', type: 'text' }, { key: 'first_visit', header: 'First visit (IST)', type: 'datetime' },
  { key: 'missed_reason', header: 'Missed reason', type: 'text' },
];
const preview = (extra = {}) => ({
  data: {
    columns: COLUMNS, sortable: ['pid_number', 'first_visit'], sort: 'pid_number', dir: 'asc',
    rows: [{ route_assignment_id: 1, pid_id: 10, pid_number: 'P-10', address: 'मकान 12', visit_status: 'NOT_VISITED', visit_status_label: 'Not Visited', missed_reason: 'Not Visited', first_visit: null }],
    pagination: { page: 1, limit: 25, total: 1, total_pages: 1 },
    ...extra,
  },
});

const renderAt = (url) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes><Route path="/reports/:name" element={<ReportPage />} /></Routes>
  </MemoryRouter>,
);
const lastParams = () => reportsApi.preview.mock.calls.at(-1)[1];

describe('report helpers', () => {
  it('toApiParams: single day vs range', () => {
    expect(toApiParams({ mode: 'day', date: '2031-03-10', from: '2031-01-01', to: '2031-01-02', zone_id: '2', page: '' }))
      .toEqual({ zone_id: '2', date: '2031-03-10', page: 1, limit: 25 });
    expect(toApiParams({ mode: 'range', date: '2031-03-10', from: '2031-03-01', to: '2031-03-10', page: '3' }))
      .toEqual({ from: '2031-03-01', to: '2031-03-10', page: 3, limit: 25 });
  });

  it('export error messages: 422 suggests Excel, 429 limit, offline', () => {
    expect(exportErrorMessage({ response: { status: 422, data: { message: 'Too many rows for PDF (9,000 > 5,000); use Excel' } } })).toMatch(/use the Excel export/);
    expect(exportErrorMessage({ response: { status: 429, data: { message: 'Export limit reached (5 per minute).' } } })).toBe('Export limit reached (5 per minute).');
    expect(exportErrorMessage({})).toMatch(/Unable to reach the server/);
  });

  it('filenameFromDisposition reads the server filename and strips path separators', async () => {
    const { filenameFromDisposition } = await vi.importActual('../api/resources.js');
    expect(filenameFromDisposition('attachment; filename="daily-coverage_2031-03-10_all.xlsx"', 'x')).toBe('daily-coverage_2031-03-10_all.xlsx');
    expect(filenameFromDisposition('attachment; filename="../../evil.csv"', 'x')).toBe('.._.._evil.csv');
    expect(filenameFromDisposition(undefined, 'fallback.pdf')).toBe('fallback.pdf');
  });
});

describe('ReportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    perms.list = ['*'];
    reportsApi.preview.mockResolvedValue(preview());
  });

  it('URL filters drive the preview query; switching to a range sends from/to; status badges + disclaimer', async () => {
    renderAt('/reports/daily-coverage?date=2031-03-10&zone_id=2&status=NOT_VISITED');
    expect(await screen.findByText('P-10')).toBeInTheDocument();
    expect(reportsApi.preview).toHaveBeenCalledWith('daily-coverage', expect.objectContaining({ date: '2031-03-10', zone_id: '2', status: 'NOT_VISITED', page: 1, limit: 25 }), expect.anything());
    expect(screen.getByRole('heading', { name: 'Daily PID Coverage' })).toBeInTheDocument();
    expect(screen.getAllByText('Not Visited').length).toBeGreaterThan(0);
    expect(screen.getByTestId('gps-disclaimer')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Dates'), 'range');
    await userEvent.type(screen.getByLabelText('From'), '2031-03-01');
    await userEvent.type(screen.getByLabelText('To'), '2031-03-10');
    await waitFor(() => expect(lastParams()).toMatchObject({ from: '2031-03-01', to: '2031-03-10' }));
    expect(lastParams()).not.toHaveProperty('date');

    await userEvent.click(screen.getByRole('button', { name: /First visit/ }));
    await waitFor(() => expect(lastParams()).toMatchObject({ sort: 'first_visit', dir: 'asc' }));
  });

  it('export: blob saved under the server filename; buttons disabled while in flight', async () => {
    let resolve;
    reportsApi.export.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderAt('/reports/ward-wise?date=2031-03-10');
    await screen.findByText('P-10');
    await userEvent.click(screen.getByRole('button', { name: 'Export Excel' }));
    expect(reportsApi.export).toHaveBeenCalledWith('ward-wise', expect.objectContaining({ date: '2031-03-10' }), 'xlsx');
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeDisabled();
    expect(screen.getByText(/Preparing XLSX/)).toBeInTheDocument();
    const blob = new Blob(['x']);
    resolve({ blob, filename: 'ward-wise_2031-03-10_all.xlsx' });
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(blob, 'ward-wise_2031-03-10_all.xlsx'));
    expect(screen.getByRole('button', { name: 'Export PDF' })).not.toBeDisabled();
  });

  it('422 (PDF too large) and 429 (rate limit) are explained', async () => {
    reportsApi.export.mockRejectedValueOnce({ response: { status: 422, data: { message: 'Too many rows for PDF (6,000 > 5,000); use Excel' } } });
    renderAt('/reports/daily-coverage?date=2031-03-10');
    await screen.findByText('P-10');
    await userEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many rows for PDF.*Excel export/);
    reportsApi.export.mockRejectedValueOnce({ response: { status: 429, data: { message: 'Export limit reached (5 per minute). Please wait a moment and try again.' } } });
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText(/Export limit reached/)).toBeInTheDocument();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('export buttons hidden without reports:export', async () => {
    perms.list = ['reports:read'];
    renderAt('/reports/agency-wise?date=2031-03-10');
    await screen.findByText('P-10');
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
  });

  it('missed PIDs: reason chips with counts filter by reason', async () => {
    reportsApi.preview.mockResolvedValue(preview({
      reason_counts: [
        { reason: 'NOT_VISITED', label: 'Not Visited', count: 12 }, { reason: 'GPS_DATA_UNAVAILABLE', label: 'GPS Data Unavailable', count: 3 },
        { reason: 'GPS_VISIT_CANDIDATE', label: 'GPS Visit Candidate', count: 7 }],
    }));
    renderAt('/reports/missed-pids?date=2031-03-10');
    const chips = await screen.findByRole('group', { name: 'Missed reasons' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent.replace(/\s+/g, ' ').trim()))
      .toEqual(['✕ Not Visited12', '? GPS Data Unavailable3', '◐ GPS Visit Candidate7']);
    await userEvent.click(within(chips).getByRole('button', { name: /GPS Data Unavailable/ }));
    await waitFor(() => expect(lastParams()).toMatchObject({ status: 'GPS_DATA_UNAVAILABLE' }));
    expect(within(chips).getByRole('button', { name: /GPS Data Unavailable/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('unknown report name -> not found page', () => {
    renderAt('/reports/salaries');
    expect(screen.getByText('Page not found')).toBeInTheDocument();
  });
});
