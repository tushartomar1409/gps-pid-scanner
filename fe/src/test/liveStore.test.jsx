// GUIDE #9 G1: live store — merge, older delta ignored, connection-status ageing (fake timers), resync refetch.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ageStatus, applyAgeing, countByStatus, findVehicle, fromSnapshot, mergeDeltas, agoLabel } from '../pages/live/liveStore.js';
import { useLiveVehicles } from '../pages/live/useLiveVehicles.js';
import { createSocketClient } from '../realtime/socketClient.js';

const T0 = Date.parse('2031-05-01T04:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const snap = () => fromSnapshot([
  { vehicle_id: 1, vehicle_number: 'HR55 A 1001', latitude: 28.4, longitude: 77.3, recorded_at: iso(T0), connection_status: 'ONLINE' },
  { vehicle_id: 2, vehicle_number: 'HR55 B 2002', latitude: null, longitude: null, recorded_at: null, connection_status: 'NO_DATA' },
  { vehicle_id: 3, vehicle_number: 'HR55 C 3003', latitude: 28.5, longitude: 77.1, recorded_at: iso(T0), connection_status: 'INACTIVE' },
]);

describe('mergeDeltas', () => {
  it('merges a newer delta (lat/lng -> latitude/longitude) and reports the newest time', () => {
    const m = snap();
    const r = mergeDeltas(m, [{ vehicle_id: 1, lat: 28.41, lng: 77.31, speed: 14, heading: 90, recorded_at: iso(T0 + 30_000), connection_status: 'ONLINE' }]);
    expect(r.changed).toBe(true);
    expect(r.map).not.toBe(m);
    expect(r.map.get(1)).toMatchObject({ latitude: 28.41, longitude: 77.31, speed: 14, heading: 90, recorded_at: iso(T0 + 30_000), vehicle_number: 'HR55 A 1001' });
    expect(r.newest).toBe(T0 + 30_000);
    expect(m.get(1).latitude).toBe(28.4); // immutable
  });

  it('ignores a delta older than (or equal to) the stored recorded_at', () => {
    const m = snap();
    const older = mergeDeltas(m, [{ vehicle_id: 1, lat: 1, lng: 1, recorded_at: iso(T0 - 1000) }]);
    const same = mergeDeltas(m, [{ vehicle_id: 1, lat: 1, lng: 1, recorded_at: iso(T0) }]);
    expect(older.changed).toBe(false);
    expect(older.map).toBe(m);
    expect(same.map.get(1).latitude).toBe(28.4);
  });

  it('within one batch, out-of-order deltas end on the newest point', () => {
    const r = mergeDeltas(snap(), [
      { vehicle_id: 1, lat: 2, lng: 2, recorded_at: iso(T0 + 60_000) },
      { vehicle_id: 1, lat: 1, lng: 1, recorded_at: iso(T0 + 30_000) },
    ]);
    expect(r.map.get(1)).toMatchObject({ latitude: 2, recorded_at: iso(T0 + 60_000) });
  });

  it('ignores vehicles outside the snapshot; first fix of a NO_DATA vehicle is applied; INACTIVE stays INACTIVE', () => {
    const r = mergeDeltas(snap(), [
      { vehicle_id: 99, lat: 1, lng: 1, recorded_at: iso(T0 + 1) },
      { vehicle_id: 2, lat: 28.6, lng: 77.2, recorded_at: iso(T0 + 1), connection_status: 'ONLINE' },
      { vehicle_id: 3, lat: 28.6, lng: 77.2, recorded_at: iso(T0 + 1), connection_status: 'ONLINE' },
    ]);
    expect(r.map.has(99)).toBe(false);
    expect(r.map.get(2)).toMatchObject({ latitude: 28.6, connection_status: 'ONLINE' });
    expect(r.map.get(3).connection_status).toBe('INACTIVE');
  });
});

describe('ageing', () => {
  it('ageStatus: ONLINE until offline_after, then OFFLINE; no fix -> NO_DATA; INACTIVE kept', () => {
    const v = { latitude: 1, recorded_at: iso(T0), connection_status: 'ONLINE' };
    expect(ageStatus(v, T0 + 299_000, 300)).toBe('ONLINE');
    expect(ageStatus(v, T0 + 301_000, 300)).toBe('OFFLINE');
    expect(ageStatus({ latitude: null, recorded_at: null }, T0, 300)).toBe('NO_DATA');
    expect(ageStatus({ ...v, connection_status: 'INACTIVE' }, T0 + 10e6, 300)).toBe('INACTIVE');
    const m = snap();
    expect(applyAgeing(m, T0 + 1000, 300)).toBe(m); // unchanged -> same instance
    expect(countByStatus(applyAgeing(m, T0 + 400_000, 300).values())).toEqual({ ONLINE: 0, OFFLINE: 1, NO_DATA: 1, INACTIVE: 1 });
  });

  it('helpers: agoLabel and vehicle-number search (spaces/case-insensitive, exact before prefix)', () => {
    expect(agoLabel(iso(T0), T0 + 12_000)).toBe('12 s ago');
    expect(agoLabel(iso(T0), T0 + 5 * 60_000)).toBe('5 min ago');
    expect(agoLabel(null, T0)).toBe('never');
    const all = [...snap().values()];
    expect(findVehicle(all, 'hr55b2002').vehicle_id).toBe(2);
    expect(findVehicle(all, 'HR55 C').vehicle_id).toBe(3);
    expect(findVehicle(all, 'nope')).toBeNull();
  });
});

describe('useLiveVehicles', () => {
  afterEach(() => vi.useRealTimers());

  it('snapshot -> socket delta -> client ageing every 30 s (fake timers) -> resync refetch', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: T0 + 10_000 });
    const client = createSocketClient({ ioFactory: () => ({ on: vi.fn(), onAny: vi.fn(), io: { on: vi.fn() }, disconnect: vi.fn() }) });
    const fetcher = vi.fn().mockResolvedValue({ data: { vehicles: [{ vehicle_id: 1, vehicle_number: 'V1', latitude: 28.4, longitude: 77.3, recorded_at: iso(T0), connection_status: 'ONLINE' }] } });
    const { result } = renderHook(() => useLiveVehicles({ zone_id: '1' }, { offlineAfterSeconds: 300, fetcher, client }));
    await waitFor(() => expect(result.current.vehicles.size).toBe(1));
    expect(fetcher).toHaveBeenCalledWith({ zone_id: '1', view: 'map' }, expect.objectContaining({ signal: expect.anything() }));

    act(() => client.emitLocal('vehicle:locations', [{ vehicle_id: 1, lat: 28.5, lng: 77.4, recorded_at: iso(T0 + 20_000), connection_status: 'ONLINE' }]));
    expect(result.current.vehicles.get(1)).toMatchObject({ latitude: 28.5, connection_status: 'ONLINE' });
    expect(result.current.lastDeltaAt).toBe(T0 + 20_000);

    // older delta ignored by the hook too
    act(() => client.emitLocal('vehicle:locations', [{ vehicle_id: 1, lat: 0, lng: 0, recorded_at: iso(T0) }]));
    expect(result.current.vehicles.get(1).latitude).toBe(28.5);

    // no new data for > 300 s: the 30 s ageing tick turns it OFFLINE without any server push
    await act(async () => { vi.advanceTimersByTime(330_000); });
    expect(result.current.vehicles.get(1).connection_status).toBe('OFFLINE');

    // socket re-connect -> REST snapshot refetched
    const handlers = {};
    const client2 = createSocketClient({ ioFactory: () => ({ on: (e, fn) => { handlers[e] = fn; }, onAny: vi.fn(), io: { on: vi.fn() }, disconnect: vi.fn() }) });
    const fetcher2 = vi.fn().mockResolvedValue({ data: { vehicles: [] } });
    renderHook(() => useLiveVehicles({}, { fetcher: fetcher2, client: client2 }));
    await waitFor(() => expect(fetcher2).toHaveBeenCalledTimes(1));
    client2.connect('tok');
    act(() => handlers.connect()); // first connect: no resync
    expect(fetcher2).toHaveBeenCalledTimes(1);
    act(() => { handlers.disconnect('transport close'); handlers.connect(); }); // re-connect
    await waitFor(() => expect(fetcher2).toHaveBeenCalledTimes(2));
  });
});
