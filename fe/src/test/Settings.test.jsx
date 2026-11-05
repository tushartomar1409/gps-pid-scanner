import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsProvider, SettingsContext, useSettings, fromApi, DEFAULT_SETTINGS } from '../settings/SettingsContext.jsx';
import { ToastProvider } from '../components/Toast.jsx';
import { FixLocationModal } from '../pages/pids/FixLocationModal.jsx';
import { settingsApi, pidsApi } from '../api/resources.js';

const auth = { user: null };
vi.mock('../auth/AuthContext.jsx', () => ({ useAuth: () => auth }));
vi.mock('../api/resources.js', () => ({ settingsApi: { public: vi.fn() }, pidsApi: { updateCoordinates: vi.fn() } }));

function Probe() {
  const s = useSettings();
  return <p>{s.loaded ? 'loaded' : 'defaults'} radius={s.detectionRadiusM} offline={s.offlineAfterSeconds} tz={s.timezone}</p>;
}

describe('public settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = null;
  });

  it('maps API keys and falls back to defaults for missing ones', () => {
    expect(fromApi({ 'detection.radius_m': 45 })).toMatchObject({ detectionRadiusM: 45, offlineAfterSeconds: 300, loaded: true });
    expect(DEFAULT_SETTINGS.serviceAreaBbox).toEqual({ min_lat: 6, max_lat: 37.5, min_lng: 68, max_lng: 97.5 });
  });

  it('loads once after login; uses defaults before login', async () => {
    settingsApi.public.mockResolvedValue({ data: { 'detection.radius_m': 45, 'gps.offline_after_seconds': 600, 'app.timezone': 'Asia/Kolkata' } });
    const { rerender } = render(<SettingsProvider><Probe /></SettingsProvider>);
    expect(screen.getByText(/defaults radius=30/)).toBeInTheDocument();
    expect(settingsApi.public).not.toHaveBeenCalled();

    auth.user = { id: 1 };
    rerender(<SettingsProvider><Probe /></SettingsProvider>);
    expect(await screen.findByText('loaded radius=45 offline=600 tz=Asia/Kolkata')).toBeInTheDocument();
    rerender(<SettingsProvider><Probe /></SettingsProvider>);
    await waitFor(() => expect(settingsApi.public).toHaveBeenCalledTimes(1));
  });

  it('fix-location uses the server bbox, not a build-time env value', async () => {
    const tight = { ...DEFAULT_SETTINGS, serviceAreaBbox: { min_lat: 28, max_lat: 29, min_lng: 77, max_lng: 78 }, loaded: true };
    render(
      <SettingsContext.Provider value={tight}>
        <ToastProvider>
          <FixLocationModal pid={{ id: 1, pid_number: 'P1', latitude: 28.4, longitude: 77.3 }} onClose={() => {}} renderMap={false} />
        </ToastProvider>
      </SettingsContext.Provider>,
    );
    // Mumbai: inside India (default bbox) but outside this tight server bbox -> must warn first.
    await userEvent.clear(screen.getByLabelText('Latitude'));
    await userEvent.type(screen.getByLabelText('Latitude'), '19.07');
    await userEvent.clear(screen.getByLabelText('Longitude'));
    await userEvent.type(screen.getByLabelText('Longitude'), '72.87');
    await userEvent.click(screen.getByRole('button', { name: 'Save location' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/outside the configured service area/);
    expect(pidsApi.updateCoordinates).not.toHaveBeenCalled();
  });
});
