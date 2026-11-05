import { useCallback, useEffect, useRef, useState } from 'react';
import { gpsApi } from '../../api/resources.js';
import { useResync, useSocketEvent } from '../../realtime/hooks.js';
import { applyAgeing, fromSnapshot, mergeDeltas } from './liveStore.js';

/**
 * Snapshot (REST, filtered server-side) + live deltas + 30 s client ageing + refetch on resync.
 * Returns { vehicles: Map, loading, error, reload, lastDeltaAt }.
 */
export function useLiveVehicles(filters, { offlineAfterSeconds = 300, ageEveryMs = 30_000, fetcher = gpsApi.liveVehicles, client } = {}) {
  const [map, setMap] = useState(() => new Map());
  const [state, setState] = useState({ loading: true, error: null });
  const [lastDeltaAt, setLastDeltaAt] = useState(null);
  const key = JSON.stringify(filters);
  const ctrl = useRef(null);
  const offlineRef = useRef(offlineAfterSeconds);
  offlineRef.current = offlineAfterSeconds;

  const reload = useCallback(() => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetcher({ ...JSON.parse(key), view: 'map' }, { signal: c.signal })
      .then(({ data }) => {
        if (c.signal.aborted) return;
        setMap(applyAgeing(fromSnapshot(data.vehicles || []), Date.now(), offlineRef.current));
        setState({ loading: false, error: null });
      })
      .catch((err) => {
        if (c.signal.aborted || err?.name === 'CanceledError') return;
        setState({ loading: false, error: 'Could not load live vehicles' });
      });
  }, [key, fetcher]);

  useEffect(() => {
    reload();
    return () => ctrl.current?.abort();
  }, [reload]);

  useSocketEvent('vehicle:locations', (deltas) => {
    setMap((m) => {
      const r = mergeDeltas(m, deltas);
      if (r.changed) setLastDeltaAt(r.newest);
      return r.map;
    });
  }, client);
  useResync(reload, client);

  useEffect(() => {
    const t = setInterval(() => setMap((m) => applyAgeing(m, Date.now(), offlineRef.current)), ageEveryMs);
    return () => clearInterval(t);
  }, [ageEveryMs]);

  return { vehicles: map, ...state, reload, lastDeltaAt };
}
