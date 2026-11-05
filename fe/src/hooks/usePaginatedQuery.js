import { useCallback, useEffect, useRef, useState } from 'react';
import { parseApiError } from '../utils/apiErrors.js';

/**
 * Fetches a paginated list: fetcher(params, { signal }) -> { data, pagination }.
 * Re-fetches when params change (by value), aborts stale requests, keeps previous rows while loading.
 */
export function usePaginatedQuery(fetcher, params) {
  const [state, setState] = useState({ rows: [], pagination: null, loading: true, error: null });
  const [reloadKey, setReloadKey] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    fetcherRef
      .current(JSON.parse(paramsKey), { signal: controller.signal })
      .then(({ data, pagination }) => setState({ rows: data || [], pagination: pagination || null, loading: false, error: null }))
      .catch((err) => {
        const parsed = parseApiError(err);
        if (parsed.canceled) return;
        setState((s) => ({ ...s, loading: false, error: parsed.message }));
      });
    return () => controller.abort();
  }, [paramsKey, reloadKey]);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);
  return { ...state, refetch };
}
