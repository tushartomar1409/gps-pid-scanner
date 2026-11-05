import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { GpsStatusBadge } from '../components/GpsStatusBadge.jsx';
import { gpsApi } from '../api/resources.js';

vi.mock('../api/resources.js', () => ({ gpsApi: { providerStatus: vi.fn() } }));

const status = (state, extra = {}) => ({ data: { provider: 'simulator', state, reason: null, last_success_at: '2026-11-05T05:00:00Z', ...extra } });

describe('GpsStatusBadge', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the provider state with a coloured dot and refreshes every 60 s', async () => {
    gpsApi.providerStatus.mockResolvedValueOnce(status('UP')).mockResolvedValueOnce(status('DOWN', { reason: '3 consecutive failed runs' }));
    render(<GpsStatusBadge />);
    await act(async () => {});
    const badge = screen.getByRole('status');
    expect(badge).toHaveTextContent('GPS up');
    expect(badge.getAttribute('title')).toMatch(/Last success: /);
    expect(badge.querySelector('.bg-emerald-500')).not.toBeNull();

    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(gpsApi.providerStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('GPS down');
    expect(screen.getByRole('status').getAttribute('title')).toMatch(/3 consecutive failed runs/);
    expect(screen.getByRole('status').querySelector('.bg-red-600')).not.toBeNull();
  });

  it('shows a grey "not polled yet" badge when the server reports UNKNOWN (never polled)', async () => {
    gpsApi.providerStatus.mockResolvedValueOnce(status('UNKNOWN', { reason: 'No poll has run yet', last_success_at: null }));
    render(<GpsStatusBadge />);
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent('GPS not polled yet');
    expect(screen.getByRole('status').querySelector('.bg-slate-400')).not.toBeNull();
    expect(screen.getByRole('status').getAttribute('title')).toMatch(/Last success: never/);
  });

  it('shows DEGRADED in amber and UNKNOWN when the status call fails', async () => {
    gpsApi.providerStatus.mockResolvedValueOnce(status('DEGRADED')).mockRejectedValueOnce(new Error('network'));
    render(<GpsStatusBadge intervalMs={1000} />);
    await act(async () => {});
    expect(screen.getByRole('status').querySelector('.bg-amber-500')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByRole('status')).toHaveTextContent('GPS status unknown');
  });
});
