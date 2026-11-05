// Live Vehicle Tracking (GUIDE #9 C, flow §10).
import { useEffect, useMemo, useState } from 'react';
import { useSettings } from '../../settings/SettingsContext.jsx';
import { MonitoringFilters, usePermittedLookups, useUrlFilters } from '../../components/MonitoringFilters.jsx';
import { BaseMap } from '../../components/map/BaseMap.jsx';
import { FitToPoints } from '../../components/map/MapHelpers.jsx';
import { ErrorState } from '../../components/ErrorState.jsx';
import { Button } from '../../components/Button.jsx';
import { CONNECTION_STATUS } from '../../utils/visitStatus.js';
import { useLiveVehicles } from './useLiveVehicles.js';
import { agoLabel, countByStatus, findVehicle } from './liveStore.js';
import { FlyTo, VehicleMarkersLayer } from './VehicleMarkersLayer.jsx';
import { VehiclePanel } from './VehiclePanel.jsx';

const FILTER_KEYS = ['zone_id', 'ward_id', 'agency_id', 'vehicle_id', 'vehicle_type', 'route_id', 'connection_status'];

export default function LiveTrackingPage() {
  const settings = useSettings();
  const [filters, setFilters] = useUrlFilters(FILTER_KEYS);
  const lookups = usePermittedLookups(['zones', 'wards', 'agencies', 'vehicles', 'routes']);
  // connection_status is applied on the client too: client-side ageing can move a vehicle to OFFLINE.
  const { connection_status: statusFilter, ...serverFilters } = filters;
  const live = useLiveVehicles(serverFilters, { offlineAfterSeconds: settings.offlineAfterSeconds });
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  const [flyTarget, setFlyTarget] = useState(null);
  const [searchMsg, setSearchMsg] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const all = useMemo(() => [...live.vehicles.values()], [live.vehicles]);
  const shown = useMemo(() => (statusFilter ? all.filter((v) => v.connection_status === statusFilter) : all), [all, statusFilter]);
  const counts = useMemo(() => countByStatus(all), [all]);
  const fitPoints = useMemo(() => shown.filter((v) => v.latitude != null).map((v) => [v.latitude, v.longitude]), [shown]);

  const onSearch = (e) => {
    e.preventDefault();
    const v = findVehicle(all, search);
    if (!v) return setSearchMsg('No vehicle matches');
    setSearchMsg('');
    setSelected(v.vehicle_id);
    if (v.latitude != null) setFlyTarget({ lat: v.latitude, lng: v.longitude, nonce: Date.now() });
    else setSearchMsg(`${v.vehicle_number} has no GPS position yet`);
    return undefined;
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Live Vehicle Tracking</h1>
          <p className="text-sm text-slate-500" aria-live="polite">
            {shown.length} vehicles shown · last update {live.lastDeltaAt ? agoLabel(live.lastDeltaAt, now) : 'none since page load'}
          </p>
        </div>
        <form onSubmit={onSearch} className="flex items-end gap-2" role="search" aria-label="Find vehicle">
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Find vehicle
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Vehicle number" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <Button type="submit" variant="secondary">Go</Button>
          {searchMsg && <span className="text-xs text-red-700" role="status">{searchMsg}</span>}
        </form>
      </div>
      <MonitoringFilters values={filters} onChange={setFilters} fields={FILTER_KEYS} lookups={lookups} />
      {live.error && !all.length ? (
        <ErrorState message={live.error} onRetry={live.reload} />
      ) : (
        <div className="flex flex-col gap-3 lg:flex-row">
          <div className="relative min-w-0 flex-1">
            <BaseMap className="h-[calc(100vh-300px)] min-h-[420px]">
              <FitToPoints points={fitPoints} fitKey={live.loading ? null : JSON.stringify(serverFilters)} />
              <VehicleMarkersLayer vehicles={shown} selectedId={selected} onSelect={setSelected} />
              <FlyTo target={flyTarget} />
            </BaseMap>
            <div className="pointer-events-none absolute bottom-3 left-3 z-[400]">
              <div className="pointer-events-auto rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-xs shadow-sm" aria-label="Legend">
                <p className="mb-1 font-semibold text-slate-700">Vehicle status</p>
                <ul className="flex flex-col gap-1">
                  {Object.entries(CONNECTION_STATUS).map(([k, s]) => (
                    <li key={k} className="flex items-center gap-2 text-slate-600">
                      <span className="inline-block h-3 w-3 rounded-full border-2" style={{ background: s.fill, borderColor: s.stroke === '#ffffff' ? s.fill : s.stroke }} aria-hidden="true" />
                      {s.label} <span className="ml-auto tabular-nums font-medium">{counts[k] || 0}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {live.loading && <div className="absolute right-3 top-3 z-[400] rounded bg-white/90 px-2 py-1 text-xs shadow">Loading…</div>}
          </div>
          {selected && <VehiclePanel vehicleId={selected} live={live.vehicles.get(selected)} onClose={() => setSelected(null)} />}
        </div>
      )}
    </div>
  );
}
