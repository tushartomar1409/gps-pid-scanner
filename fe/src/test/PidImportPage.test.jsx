import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.jsx';
import PidImportPage, { checkFile } from '../pages/pids/PidImportPage.jsx';
import { pidsApi } from '../api/resources.js';

vi.mock('../api/resources.js', () => ({ pidsApi: { importFile: vi.fn(), template: vi.fn() } }));

const summary = (o) => ({ total: 3, valid: 2, errors: 1, warnings: 1, duplicates_in_file: 0, existing_in_db: 0, findings_total: 2, ...o });
const findings = [
  { row: 2, pid_number: 'A1', level: 'error', field: 'zone_code', message: 'Unknown zone code X' },
  { row: 3, pid_number: 'A2', level: 'warning', field: 'latitude', message: 'Missing coordinates' },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <PidImportPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}
const csvFile = (name = 'pids.csv', size = 20) => new File(['x'.repeat(size)], name, { type: 'text/csv' });

describe('PID import wizard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('checkFile rejects bad extensions, empty and >10 MB files', () => {
    expect(checkFile(csvFile('a.txt'))).toMatch(/Only .csv and .xlsx/);
    expect(checkFile(csvFile('a.csv', 0))).toMatch(/empty/);
    expect(checkFile({ name: 'a.xlsx', size: 11 * 1024 * 1024 })).toMatch(/10 MB/);
    expect(checkFile(csvFile('A.XLSX'))).toBeNull();
  });

  it('upload -> validate -> confirm -> commit, reusing the same File', async () => {
    pidsApi.importFile
      .mockResolvedValueOnce({ data: { summary: summary(), findings, findings_truncated: false } })
      .mockResolvedValueOnce({ data: { summary: summary(), findings, result: { inserted: 2, updated: 0, skipped_existing: 0, route_links: 0 } } });
    renderPage();
    const file = csvFile();
    expect(screen.getByRole('button', { name: 'Validate file' })).toBeDisabled();
    await userEvent.upload(screen.getByLabelText('Import file'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Validate file' }));

    expect(await screen.findByText('2. Validation results')).toBeInTheDocument();
    expect(pidsApi.importFile).toHaveBeenNthCalledWith(1, file, { mode: 'validate', on_existing: 'skip' }, expect.any(Function));
    expect(screen.getByText('Unknown zone code X')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Show'), 'warning');
    expect(screen.queryByText('Unknown zone code X')).not.toBeInTheDocument();
    expect(screen.getByText('Missing coordinates')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Import 2 valid rows' }));
    const dialog = screen.getByRole('dialog', { name: 'Import PIDs?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));

    expect(await screen.findByText('3. Import complete')).toBeInTheDocument();
    expect(pidsApi.importFile).toHaveBeenNthCalledWith(2, file, { mode: 'commit', on_existing: 'skip' }, expect.any(Function));
    expect(screen.getByRole('link', { name: 'Fix missing coordinates' })).toHaveAttribute('href', '/pids?has_coords=false');
  });

  it('disables commit when there are 0 valid rows', async () => {
    pidsApi.importFile.mockResolvedValueOnce({ data: { summary: summary({ valid: 0, errors: 3 }), findings, findings_truncated: false } });
    renderPage();
    await userEvent.upload(screen.getByLabelText('Import file'), csvFile());
    await userEvent.click(screen.getByRole('button', { name: 'Validate file' }));
    expect(await screen.findByRole('button', { name: 'Import 0 valid rows' })).toBeDisabled();
    expect(screen.getByText(/no valid rows to import/i)).toBeInTheDocument();
  });

  it('shows server errors (e.g. too many rows) and stays on step 1', async () => {
    pidsApi.importFile.mockRejectedValueOnce({ response: { status: 422, data: { success: false, message: 'File has 60000 data rows; the maximum is 50000' } } });
    renderPage();
    await userEvent.upload(screen.getByLabelText('Import file'), csvFile());
    await userEvent.click(screen.getByRole('button', { name: 'Validate file' }));
    expect(await screen.findByText(/maximum is 50000/)).toBeInTheDocument();
    expect(screen.queryByText('2. Validation results')).not.toBeInTheDocument();
  });

  it('changing "existing PID" handling after validation requires re-validation', async () => {
    pidsApi.importFile.mockResolvedValueOnce({ data: { summary: summary(), findings, findings_truncated: false } });
    renderPage();
    await userEvent.upload(screen.getByLabelText('Import file'), csvFile());
    await userEvent.click(screen.getByRole('button', { name: 'Validate file' }));
    await screen.findByText('2. Validation results');
    await userEvent.click(screen.getByRole('radio', { name: /Update it/ }));
    expect(screen.queryByText('2. Validation results')).not.toBeInTheDocument();
  });
});
