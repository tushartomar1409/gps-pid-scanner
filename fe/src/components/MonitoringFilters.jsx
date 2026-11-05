// Shared filter bar for the monitoring pages, synced to the URL (?date=&zone_id=&ward_id=&agency_id=&vehicle_id=...).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { referenceApi } from '../api/resources.js';
import { usePermission } from '../auth/usePermission.js';
import { toOptions } from '../hooks/useLookups.js';
import { Select } from './Select.jsx';
import { Input } from './Input.jsx';
import { todayIST } from '../utils/dates.js';

/** URL-synced filter state. `defaults` fill missing keys (e.g. date = today IST). */
export function useUrlFilters(keys, defaults = {}) {
  const [sp, setSp] = useSearchParams();
  const sig = keys.join(',');
  const values = useMemo(() => {
    const out = {};
    for (const k of sig.split(',')) out[k] = sp.get(k) ?? defaults[k] ?? '';
    return out;
  }, [sp, sig]); // eslint-disable-line react-hooks/exhaustive-deps -- defaults are static per page
  const set = useCallback(
    (patch) =>
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === '' || v === null || v === undefined) next.delete(k);
            else next.set(k, String(v));
          }
          return next;
        },
        { replace: true },
      ),
    [setSp],
  );
  return [values, set];
}

/** Lookups limited to the types this user may read (the endpoint 403s on any missing <type>:read). */
export function usePermittedLookups(types) {
  const can = usePermission();
  const allowed = types.filter((t) => can(`${t}:read`));
  const key = allowed.join(',');
  const [data, setData] = useState({});
  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    referenceApi.lookups(key.split(',')).then(({ data: d }) => !cancelled && setData(d)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key]);
  return data;
}

/**
 * fields: subset of ['date','zone_id','ward_id','agency_id','vehicle_id','route_id','vehicle_type','connection_status']
 */
export function MonitoringFilters({ values, onChange, fields, lookups, extra = null }) {
  const has = (f) => fields.includes(f);
  const wards = lookups.wards || [];
  const wardOptions = toOptions(values.zone_id ? wards.filter((w) => String(w.zone_id) === String(values.zone_id)) : wards);
  const vehicles = lookups.vehicles || [];
  const vehicleTypes = [...new Set(vehicles.map((v) => v.code).filter(Boolean))].sort();

  const onZone = (zoneId) => {
    const w = wards.find((x) => String(x.id) === String(values.ward_id));
    onChange({ zone_id: zoneId, ...(values.ward_id && (!zoneId || String(w?.zone_id) !== String(zoneId)) ? { ward_id: '' } : {}) });
  };

  return (
    <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:grid-cols-3 lg:grid-cols-6" role="search" aria-label="Filters">
      {has('date') && <Input label="Date" type="date" value={values.date} max={todayIST()} onChange={(e) => onChange({ date: e.target.value })} />}
      {has('zone_id') && lookups.zones && (
        <Select label="Zone" placeholder="All zones" value={values.zone_id} options={toOptions(lookups.zones)} onChange={(e) => onZone(e.target.value)} />
      )}
      {has('ward_id') && lookups.wards && (
        <Select label="Ward" placeholder="All wards" value={values.ward_id} options={wardOptions} onChange={(e) => onChange({ ward_id: e.target.value })} />
      )}
      {has('agency_id') && lookups.agencies && (
        <Select label="Agency" placeholder="All agencies" value={values.agency_id} options={toOptions(lookups.agencies)} onChange={(e) => onChange({ agency_id: e.target.value })} />
      )}
      {has('vehicle_id') && lookups.vehicles && (
        <Select
          label="Vehicle"
          placeholder="All vehicles"
          value={values.vehicle_id}
          options={vehicles.map((v) => ({ value: String(v.id), label: v.name }))}
          onChange={(e) => onChange({ vehicle_id: e.target.value })}
        />
      )}
      {has('vehicle_type') && lookups.vehicles && (
        <Select label="Vehicle type" placeholder="All types" value={values.vehicle_type} options={vehicleTypes.map((t) => ({ value: t, label: t }))} onChange={(e) => onChange({ vehicle_type: e.target.value })} />
      )}
      {has('route_id') && lookups.routes && (
        <Select label="Route" placeholder="All routes" value={values.route_id} options={toOptions(lookups.routes)} onChange={(e) => onChange({ route_id: e.target.value })} />
      )}
      {has('connection_status') && (
        <Select
          label="Status"
          placeholder="All statuses"
          value={values.connection_status}
          options={[{ value: 'ONLINE', label: 'Online' }, { value: 'OFFLINE', label: 'Offline' }, { value: 'NO_DATA', label: 'No data' }, { value: 'INACTIVE', label: 'Inactive' }]}
          onChange={(e) => onChange({ connection_status: e.target.value })}
        />
      )}
      {extra}
    </div>
  );
}
