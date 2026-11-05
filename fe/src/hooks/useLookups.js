import { useEffect, useState } from 'react';
import { referenceApi } from '../api/resources.js';

/** Loads active zones/wards/agencies for dropdowns: useLookups(['zones','wards']). */
export function useLookups(types) {
  const key = types.join(',');
  const [state, setState] = useState({ data: {}, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    referenceApi
      .lookups(key.split(','))
      .then(({ data }) => !cancelled && setState({ data, loading: false, error: null }))
      .catch(() => !cancelled && setState({ data: {}, loading: false, error: 'Could not load dropdown options' }));
    return () => {
      cancelled = true;
    };
  }, [key]);

  return state;
}

export const toOptions = (items = []) =>
  items.map((i) => ({ value: String(i.id), label: i.code && i.code !== i.name ? `${i.name} (${i.code})` : i.name }));
