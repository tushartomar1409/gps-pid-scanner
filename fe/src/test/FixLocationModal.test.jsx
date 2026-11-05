import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast.jsx';
import { FixLocationModal, parseLatLng } from '../pages/pids/FixLocationModal.jsx';
import { pidsApi } from '../api/resources.js';
import { serviceAreaWarning } from '../utils/mapStyles.js';

vi.mock('../api/resources.js', () => ({ pidsApi: { updateCoordinates: vi.fn() } }));

const INDIA = { min_lat: 6, max_lat: 37.5, min_lng: 68, max_lng: 97.5 };
const pid = { id: 7, pid_number: 'PID10001', latitude: 28.4082, longitude: 77.3178, address: 'H.No 1' };

function renderModal(p = pid) {
  const onSaved = vi.fn();
  render(
    <ToastProvider>
      <FixLocationModal pid={p} onClose={() => {}} onSaved={onSaved} renderMap={false} />
    </ToastProvider>,
  );
  return onSaved;
}

async function setInputs(lat, lng) {
  const latInput = screen.getByLabelText('Latitude');
  const lngInput = screen.getByLabelText('Longitude');
  await userEvent.clear(latInput);
  await userEvent.type(latInput, lat);
  await userEvent.clear(lngInput);
  await userEvent.type(lngInput, lng);
}

describe('fix location', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pure helpers: parse inputs and detect outside / swapped points', () => {
    expect(parseLatLng('28.4', '77.3')).toEqual({ lat: 28.4, lng: 77.3 });
    expect(parseLatLng('95', 'x').errors).toMatchObject({ latitude: expect.any(String), longitude: expect.any(String) });
    expect(serviceAreaWarning(28.4, 77.3, INDIA)).toBeNull();
    expect(serviceAreaWarning(77.3, 28.4, INDIA)).toMatch(/swapped/);
    expect(serviceAreaWarning(51.5, -0.12, INDIA)).toMatch(/outside/);
  });

  it('saves an in-area point directly (with verified flag)', async () => {
    pidsApi.updateCoordinates.mockResolvedValue({ data: { ...pid, latitude: 28.41, longitude: 77.32 } });
    const onSaved = renderModal();
    await setInputs('28.41', '77.32');
    await userEvent.click(screen.getByLabelText('Mark as verified'));
    await userEvent.click(screen.getByRole('button', { name: 'Save location' }));
    expect(pidsApi.updateCoordinates).toHaveBeenCalledWith(7, { latitude: 28.41, longitude: 77.32, verified: true });
    expect(onSaved).toHaveBeenCalled();
  });

  it('warns first for a suspicious point; "Save anyway" sends, "Cancel" does not', async () => {
    pidsApi.updateCoordinates.mockResolvedValue({ data: { ...pid, warning: 'Latitude/longitude look swapped' } });
    renderModal();
    await setInputs('77.3178', '28.4082');
    await userEvent.click(screen.getByRole('button', { name: 'Save location' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/swapped/);
    expect(pidsApi.updateCoordinates).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Save anyway' })).not.toBeInTheDocument();
    expect(pidsApi.updateCoordinates).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Save location' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    expect(pidsApi.updateCoordinates).toHaveBeenCalledWith(7, { latitude: 77.3178, longitude: 28.4082 });
  });

  it('starts empty for a PID with missing coordinates and blocks save until a point is set', async () => {
    renderModal({ id: 8, pid_number: 'PIDX', latitude: null, longitude: null });
    expect(screen.getByText(/no coordinates yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save location' })).toBeDisabled();
    await setInputs('28.5', '77.5');
    expect(screen.getByRole('button', { name: 'Save location' })).toBeEnabled();
  });
});
