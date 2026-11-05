import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

/**
 * List state (page, search, filters) synced to the URL query string so it survives reloads and
 * can be shared. Changing any filter or search resets page to 1.
 */
export function useListParams(filterKeys = []) {
  const [searchParams, setSearchParams] = useSearchParams();
  const keysSig = filterKeys.join(',');

  const params = useMemo(() => {
    const out = {
      page: Math.max(1, Number(searchParams.get('page')) || 1),
      search: searchParams.get('search') || '',
    };
    for (const k of keysSig ? keysSig.split(',') : []) out[k] = searchParams.get(k) || '';
    return out;
  }, [searchParams, keysSig]);

  const setParams = useCallback(
    (patch, { resetPage = true } = {}) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === null || v === '') next.delete(k);
            else next.set(k, String(v));
          }
          if (resetPage && !('page' in patch)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setPage = useCallback((page) => setParams({ page: page > 1 ? page : '' }, { resetPage: false }), [setParams]);

  return { params, setParams, setPage };
}
