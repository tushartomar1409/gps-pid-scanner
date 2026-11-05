// GUIDE #9 G6: settings form — validation ranges from the server schema, per-key save, reprocess confirmation.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.jsx';
import DetectionSettingsPage from '../pages/settings/DetectionSettingsPage.jsx';
import { groupDetectionSettings, parseSettingInput, rangeText } from '../pages/settings/settingsLogic.js';
import { detectionApi, settingsApi } from '../api/resources.js';

vi.mock('../api/resources.js', () => ({
  settingsApi: { all: vi.fn(), update: vi.fn() },
  detectionApi: { reprocess: vi.fn() },
  referenceApi: { lookups: vi.fn(() => Promise.resolve({ data: { zones: [{ id: 3, name: 'North' }] } })) },
}));
vi.mock('../auth/usePermission.js', () => ({ usePermission: () => () => true, hasPermission: () => true }));

const ROWS = [
  { setting_key: 'detection.radius_m', setting_value: 30, description: 'Proximity radius', editable: true, default: 30, schema: { type: 'number', minimum: 5, maximum: 200 } },
  { setting_key: 'detection.consecutive_points', setting_value: 2, editable: true, default: 2, schema: { type: 'integer', minimum: 1, maximum: 10 } },
  { setting_key: 'detection.max_speed_kmh', setting_value: null, editable: true, default: null, schema: { anyOf: [{ type: 'number', minimum: 1, maximum: 300 }, { type: 'null' }] } },
  { setting_key: 'detection.confirmation_mode', setting_value: 'consecutive_points', editable: true, default: 'consecutive_points', schema: { type: 'string', enum: ['consecutive_points', 'min_events', 'dwell'] } },
  { setting_key: 'detection.segment_evidence_enabled', setting_value: true, editable: true, default: true, schema: { type: 'boolean' } },
  { setting_key: 'detection.deviation_threshold_m', setting_value: 50, editable: true, default: 50, schema: { type: 'number', minimum: 5, maximum: 1000 } },
  { setting_key: 'gps.offline_after_seconds', setting_value: 300, editable: true, schema: { type: 'integer', minimum: 30, maximum: 86400 } },
];

const renderPage = () => render(<MemoryRouter><ToastProvider><DetectionSettingsPage /></ToastProvider></MemoryRouter>);

describe('settings logic', () => {
  it('groups only detection.* keys, in the guide’s groups', () => {
    const g = groupDetectionSettings(ROWS);
    expect(g.map((x) => x.title)).toEqual(['Proximity', 'Confirmation', 'Quality gates', 'Segment evidence', 'Comparison']);
    expect(g.flatMap((x) => x.rows).some((r) => r.setting_key.startsWith('gps.'))).toBe(false);
  });

  it('validates against the schema range, integer and nullable rules', () => {
    const num = ROWS[0].schema;
    expect(parseSettingInput(num, '4')).toEqual({ error: 'Must be at least 5' });
    expect(parseSettingInput(num, '201')).toEqual({ error: 'Must be at most 200' });
    expect(parseSettingInput(num, 'abc')).toEqual({ error: 'Enter a number' });
    expect(parseSettingInput(num, '')).toEqual({ error: 'A value is required' });
    expect(parseSettingInput(num, '42.5')).toEqual({ value: 42.5 });
    expect(parseSettingInput(ROWS[1].schema, '2.5')).toEqual({ error: 'Enter a whole number' });
    expect(parseSettingInput(ROWS[2].schema, '')).toEqual({ value: null });
    expect(parseSettingInput(ROWS[3].schema, 'dwell')).toEqual({ value: 'dwell' });
    expect(parseSettingInput(ROWS[3].schema, 'other').error).toMatch(/one of/);
    expect(rangeText(num)).toBe('5 – 200');
    expect(rangeText(ROWS[2].schema)).toBe('optional (blank = off), 1 – 300');
  });
});

describe('DetectionSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsApi.all.mockResolvedValue({ data: ROWS });
  });

  it('shows groups, ranges, the "new processing only" notice and the read-only recommendation box', async () => {
    renderPage();
    expect(await screen.findByLabelText('radius_m')).toBeInTheDocument();
    expect(screen.getByText(/5 – 200 · default 30/)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/new processing only/);
    const rec = screen.getByLabelText('Recommended field-trial starting point');
    expect(rec).toHaveTextContent(/nothing here is applied automatically/i);
    expect(within(rec).queryByRole('button')).toBeNull();
    expect(screen.queryByText('offline_after_seconds')).toBeNull();
  });

  it('per-field validation blocks the save; a valid value saves only that key', async () => {
    settingsApi.update.mockResolvedValue({ data: { ...ROWS[0], setting_value: 45 } });
    renderPage();
    const input = await screen.findByLabelText('radius_m');
    const row = input.closest('div.grid');
    await userEvent.clear(input);
    await userEvent.type(input, '500');
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Must be at most 200');
    expect(settingsApi.update).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, '45');
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(settingsApi.update).toHaveBeenCalledWith('detection.radius_m', 45));
    expect(settingsApi.update).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/radius_m saved\. Applies to new processing only/)).toBeInTheDocument();
  });

  it('shows the server validation message when the API rejects a value', async () => {
    settingsApi.update.mockRejectedValue({ response: { status: 400, data: { message: 'Invalid value for detection.consecutive_points', errors: [{ field: 'value', message: 'Too big' }] } } });
    renderPage();
    const input = await screen.findByLabelText('consecutive_points');
    await userEvent.clear(input);
    await userEvent.type(input, '3');
    await userEvent.click(within(input.closest('div.grid')).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Too big')).toBeInTheDocument();
  });

  it('reprocess needs confirmation, explains that raw GPS is kept, then shows the result', async () => {
    detectionApi.reprocess.mockResolvedValue({ message: 'Reprocessing queued', data: { assignments: 4 } });
    renderPage();
    await screen.findByLabelText('radius_m');
    await userEvent.click(screen.getByRole('button', { name: 'Reprocess…' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Raw GPS data is kept/);
    expect(detectionApi.reprocess).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(detectionApi.reprocess).not.toHaveBeenCalled();

    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'assignment');
    await userEvent.type(screen.getByLabelText('Assignment id'), '42');
    await userEvent.click(screen.getByRole('button', { name: 'Reprocess…' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('assignment #42');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reprocess' }));
    await waitFor(() => expect(detectionApi.reprocess).toHaveBeenCalledWith({ route_assignment_id: 42 }));
    expect(await screen.findByText('Reprocessing queued', { selector: 'p' })).toBeInTheDocument();
  });
});
