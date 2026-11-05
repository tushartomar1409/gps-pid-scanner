import { useCallback, useEffect, useRef, useState } from 'react';
import { pidsApi } from '../api/resources.js';
import { parseApiError } from '../utils/apiErrors.js';

/**
 * Fetches /pids/map for the visible bbox. Call setBbox(bboxString) from the map's moveend.
 * - debounced (default 300 ms) so a pan/zoom burst makes one request
 * - aborts the in-flight request when a newer bbox/filter arrives
 * Returns { setBbox, points, truncated, count, loading, error, reload }.
 */
export function useBboxQuery(filters = {}, { debounceMs = 300, limit = 5000, enabled = true, fetcher = pidsApi.map } = {}) {
  const [bbox, setBbox] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState({ points: [], truncated: false, count: 0, loading: false, error: null });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const filtersKey = JSON.stringify(filters);

  useEffect(() => {
    if (!enabled || !bbox) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState((s) => ({ ...s, loading: true, error: null }));
      fetcherRef
        .current({ ...JSON.parse(filtersKey), bbox, limit }, { signal: controller.signal })
        .then(({ data }) => {
          // A response can still arrive after abort(); never let a stale bbox overwrite a newer one.
          if (controller.signal.aborted) return;
          setState({ points: data.points, truncated: data.truncated, count: data.count, loading: false, error: null });
        })
        .catch((err) => {
          const e = parseApiError(err);
          if (e.canceled || controller.signal.aborted) return;
          setState((s) => ({ ...s, loading: false, error: e.message }));
        });
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [bbox, filtersKey, enabled, debounceMs, limit, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  return { setBbox, ...state, reload };
}
