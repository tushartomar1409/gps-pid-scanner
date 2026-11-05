// GUIDE #9 G5: dashboard renders cards from the API; headline = GPS confirmed %; disclaimer; pid:status refetch debounced.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DashboardPage from '../pages/dashboard/DashboardPage.jsx';
import { dashboardApi } from '../api/resources.js';
import { socketClient } from '../realtime/socketClient.js';
import { GPS_DISCLAIMER } from '../utils/disclaimer.js';

vi.mock('../api/resources.js', () => ({
  dashboardApi: { summary: vi.fn(), grouped: vi.fn(), dailyTrend: vi.fn(), hourly: vi.fn() },
  referenceApi: { lookups: vi.fn(() => Promise.resolve({ data: {} })) },
}));
vi.mock('../auth/usePermission.js', () => ({ usePermission: () => () => true, hasPermission: () => true }));
// Recharts needs layout measurements jsdom does not have; chart internals are not under test here.
vi.mock('../pages/dashboard/DashboardCharts.jsx', () => ({
  CoverageStackedBars: ({ groups }) => <div data-testid="stacked">{groups.length} groups</div>,
  AgencyBars: () => <div />, TrendLines: () => <div data-testid="trend" />, HourlyChart: () => <div data-testid="hourly" />,
}));

const SUMMARY = {
  date: '2031-03-10', total_vehicles: 12, active_vehicles: 9, online_now: 7, offline_vehicles: 3, total_registered_pids: 900, assigned_pids: 400,
  gps_confirmed_pids: 120, gps_candidate_pids: 80, gps_detected_pids: 200, gps_unavailable_pids: 5, remaining_pids: 280, remaining_undetected_pids: 200,
  gps_confirmed_coverage_pct: 30, gps_visit_detected_pct: 50,
};

function renderPage() {
  return render(<MemoryRouter initialEntries={['/?date=2031-03-10']}><DashboardPage debounceMs={5000} /></MemoryRouter>);
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dashboardApi.summary.mockResolvedValue({ data: SUMMARY });
    dashboardApi.grouped.mockResolvedValue({ data: { groups: [{ group_id: 1, group_name: 'Zone A', assigned: 10, confirmed: 3, candidate: 2, unavailable: 0, confirmed_pct: 30, detected_pct: 50 }] } });
    dashboardApi.dailyTrend.mockResolvedValue({ data: { days: [{ date: '2031-03-10', assigned: 400, confirmed: 120, detected: 200, confirmed_pct: 30, detected_pct: 50 }] } });
    dashboardApi.hourly.mockResolvedValue({ data: { hours: [{ hour: 9, gps_points: 10, visit_events: 2 }] } });
  });
  afterEach(() => vi.useRealTimers());

  it('renders every card from the API; the headline is GPS confirmed %, with the disclaimer', async () => {
    renderPage();
    expect(await screen.findByTestId('headline-pct')).toHaveTextContent('30%');
    expect(screen.getByLabelText('GPS Confirmed Coverage %')).toBeInTheDocument();
    expect(screen.getByText('GPS Visit Detected %').nextSibling).toHaveTextContent('50%');
    for (const [label, v] of [['Total vehicles', '12'], ['Active (GPS on date)', '9'], ['Online now', '7'], ['Offline vehicles', '3'],
      ['Total registered PIDs', '900'], ['Assigned PIDs', '400'], ['Remaining (not GPS-confirmed)', '280'], ['No GPS visit detected', '200']]) {
      expect(screen.getByText(label).nextSibling).toHaveTextContent(v);
    }
    expect(screen.getByTestId('gps-disclaimer')).toHaveTextContent(GPS_DISCLAIMER);
    expect(dashboardApi.summary).toHaveBeenCalledWith(expect.objectContaining({ date: '2031-03-10' }), expect.anything());
    expect(dashboardApi.dailyTrend).toHaveBeenCalledWith(expect.objectContaining({ from: '2031-02-25', to: '2031-03-10' }), expect.anything());
    await waitFor(() => expect(screen.getAllByTestId('stacked')).toHaveLength(2));
  });

  it('pid:status bursts trigger ONE debounced refetch after 5 s (summary + visible charts)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage();
    await screen.findByTestId('headline-pct');
    await waitFor(() => expect(dashboardApi.grouped).toHaveBeenCalledTimes(4));
    expect(dashboardApi.summary).toHaveBeenCalledTimes(1);

    act(() => {
      for (let i = 0; i < 5; i++) socketClient.emitLocal('pid:status', { changes: [], assignments: [] });
    });
    await act(async () => { vi.advanceTimersByTime(4900); });
    expect(dashboardApi.summary).toHaveBeenCalledTimes(1); // still debouncing
    await act(async () => { vi.advanceTimersByTime(200); });
    await waitFor(() => expect(dashboardApi.summary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(dashboardApi.grouped).toHaveBeenCalledTimes(8)); // jsdom: every section counts as visible
    expect(dashboardApi.dailyTrend).toHaveBeenCalledTimes(2);
    expect(dashboardApi.hourly).toHaveBeenCalledTimes(2);
  });

  it('chart sections show error-with-retry', async () => {
    dashboardApi.hourly.mockRejectedValueOnce({ response: { data: { message: 'boom' } } });
    renderPage();
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
