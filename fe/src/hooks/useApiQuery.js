import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Generic fetch-on-key hook with abort of stale requests and a stable reload().
 * fetcher(signal) -> Promise<data>. `enabled=false` skips fetching.
 */
export function useApiQuery(fetcher, key, { enabled = true } = {}) {
  const [state, setState] = useState({ data: null, loading: enabled, error: null });
  const ctrl = useRef(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(() => {
    if (!enabled) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetcherRef.current(c.signal)
      .then((data) => !c.signal.aborted && setState({ data, loading: false, error: null }))
      .catch((err) => {
        if (c.signal.aborted || err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
        setState((s) => ({ ...s, loading: false, error: err?.response?.data?.message || 'Could not load data' }));
      });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, loading: false, error: null });
      return undefined;
    }
    reload();
    return () => ctrl.current?.abort();
  }, [key, enabled, reload]);

  return { ...state, reload };
}

/** Trailing debounce of a callback (stable identity); .cancel() clears a pending call. */
export function useDebouncedCallback(fn, delayMs) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef(null);
  const cb = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fnRef.current(), delayMs);
  }, [delayMs]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return cb;
}
