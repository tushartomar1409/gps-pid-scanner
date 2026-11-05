// PID Coverage Map + Route Comparison (GUIDE #9 D, flow §11–12).
// Live (date = today): pid:status recolours PIDs in place + updates counts; vehicle:locations moves the blue
// marker and extends the trail; socket resync refetches everything.
import { useEffect, useMemo, useState } from 'react';
import { assignmentsApi, gpsApi } from '../../api/resources.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { usePermission } from '../../auth/usePermission.js';
import { useResync, useSocketEvent } from '../../realtime/hooks.js';
import { useUrlFilters } from '../../components/MonitoringFilters.jsx';
import { BaseMap } from '../../components/map/BaseMap.jsx';
import { FitToPoints } from '../../components/map/MapHelpers.jsx';
import { Drawer } from '../../components/Drawer.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { ErrorState } from '../../components/ErrorState.jsx';
import { Spinner } from '../../components/Spinner.jsx';
import { todayIST } from '../../utils/dates.js';
import { FlyTo } from '../live/VehicleMarkersLayer.jsx';
import { AssignedRouteLayer, CurrentVehicleMarker, OffRouteLayer, PidStatusLayer, TrailLayer } from './CoverageLayers.jsx';
import { ComparisonPanel, CoverageLegend, PidDetails } from './CoveragePanels.jsx';
import {
  DEFAULT_TOGGLES, appendToTrail, applyPidStatusChanges, countsFromPayload, segmentLatLngs, toggle, visiblePids,
} from './coverageLogic.js';

const TOGGLE_LABELS = [
  ['assignedRoute', 'Assigned route'], ['actualRoute', 'Actual route'], ['allPids', 'All PIDs'], ['visited', 'Visited (confirmed + candidate)'], ['unvisited', 'Unvisited'],
];

function AssignmentPicker({ date, assignmentId, onChange }) {
  const [search, setSearch] = useState('');
  const key = `${date}|${search}`;
  const q = useApiQuery((signal) => assignmentsApi.list({ operational_date: date, search, limit: 100 }, { signal }).then((r) => r.data), key);
  const options = (q.data || []).filter((a) => a.status !== 'CANCELLED').map((a) => ({ value: String(a.id), label: `${a.route_code} · ${a.vehicle_number}${a.agency_name ? ` · ${a.agency_name}` : ''}` }));
  return (
    <>
      <Input label="Search vehicle / route" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. HR55 or R-12" />
      <Select label="Assignment" placeholder={q.loading ? 'Loading…' : options.length ? 'Select assignment' : 'No assignments on this date'} value={assignmentId}
        options={options} fallbackLabel={`Assignment #${assignmentId}`} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}

export default function CoverageMapPage() {
  const can = usePermission();
  const [f, setF] = useUrlFilters(['date', 'assignment'], { date: todayIST() });
  const date = f.date || todayIST();
  const assignmentId = f.assignment ? Number(f.assignment) : null;
  const isToday = date === todayIST();

  const [toggles, setToggles] = useState(DEFAULT_TOGGLES);
  const [pids, setPids] = useState([]);
  const [counts, setCounts] = useState(null);
  const [trail, setTrail] = useState([]);
  const [vehiclePos, setVehiclePos] = useState(null);
  const [selected, setSelected] = useState(null);
  const [segment, setSegment] = useState(null);
  const [fly, setFly] = useState(null);

  const mapQ = useApiQuery((signal) => assignmentsApi.mapPids(assignmentId, { signal }).then((r) => r.data), assignmentId, { enabled: Boolean(assignmentId) });
  const cmpQ = useApiQuery((signal) => assignmentsApi.comparison(assignmentId, { signal }).then((r) => r.data), assignmentId, { enabled: Boolean(assignmentId) });
  const cmp = cmpQ.data;
  const vehicleId = cmp?.vehicle?.id;
  const vehQ = useApiQuery(
    (signal) => gpsApi.liveVehicles({ vehicle_id: vehicleId, view: 'map' }, { signal }).then((r) => r.data.vehicles[0] || null),
    vehicleId, { enabled: Boolean(vehicleId && isToday && can('gps:read')) },
  );

  // Server snapshots -> local live state.
  useEffect(() => setPids(mapQ.data?.pids || []), [mapQ.data]);
  useEffect(() => {
    setTrail(cmp?.actual_track?.points || []);
    setCounts(null);
    setSegment(null);
  }, [cmp]);
  useEffect(() => {
    const v = vehQ.data;
    setVehiclePos(v?.latitude != null ? { pos: [v.latitude, v.longitude], at: v.recorded_at } : null);
  }, [vehQ.data]);
  useEffect(() => setSelected(null), [assignmentId]);

  useSocketEvent('pid:status', (p) => {
    if (!isToday || !assignmentId) return;
    setPids((cur) => applyPidStatusChanges(cur, p?.changes, assignmentId));
    const c = countsFromPayload(p, assignmentId);
    if (c) setCounts(c);
    setSelected((s) => (s ? { ...s, visit_status: p?.changes?.find((x) => x.route_assignment_id === assignmentId && x.pid_id === s.pid_id)?.new_status ?? s.visit_status } : s));
  });
  useSocketEvent('vehicle:locations', (deltas) => {
    if (!isToday || !vehicleId) return;
    setTrail((t) => appendToTrail(t, deltas, vehicleId));
    const mine = (deltas || []).filter((d) => d.vehicle_id === vehicleId).sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at))[0];
    if (mine) setVehiclePos((cur) => (!cur || new Date(mine.recorded_at) > new Date(cur.at) ? { pos: [mine.lat, mine.lng], at: mine.recorded_at } : cur));
  });
  useResync(() => {
    if (!assignmentId) return;
    mapQ.reload();
    cmpQ.reload();
    vehQ.reload();
  });

  const shownPids = useMemo(() => visiblePids(pids, toggles), [pids, toggles]);
  const fitPoints = useMemo(() => {
    const pts = pids.filter((p) => p.latitude != null).map((p) => [p.latitude, p.longitude]);
    return pts.length ? pts : trail.map((p) => [p.latitude, p.longitude]);
  }, [pids, trail]);
  const segments = cmp?.route_deviation?.off_route_segments || [];

  const onSegment = (i) => {
    setSegment(i);
    const pts = segmentLatLngs(trail, segments[i]);
    if (pts.length) setFly({ lat: pts[Math.floor(pts.length / 2)][0], lng: pts[Math.floor(pts.length / 2)][1], nonce: Date.now() });
  };

  const unavailable = pids.filter((p) => p.latitude == null).length;
  const assignmentMeta = cmp && { route_assignment_id: assignmentId, operational_date: cmp.operational_date, route: cmp.route, vehicle: cmp.vehicle };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">PID Coverage Map</h1>
        <p className="text-sm text-slate-500">Assigned route vs actual GPS route{isToday ? ' · live' : ''}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:grid-cols-3">
        <Input label="Date" type="date" value={date} max={todayIST()} onChange={(e) => setF({ date: e.target.value, assignment: '' })} />
        <AssignmentPicker date={date} assignmentId={f.assignment} onChange={(v) => setF({ assignment: v })} />
      </div>

      {!assignmentId ? (
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <EmptyState title="Pick an assignment" message="Choose a date and one of that day's route assignments to see its PIDs, the assigned route and the actual GPS trail." />
        </div>
      ) : mapQ.error || cmpQ.error ? (
        <ErrorState message={mapQ.error || cmpQ.error} onRetry={() => { mapQ.reload(); cmpQ.reload(); }} />
      ) : (
        <div className="flex flex-col gap-3 xl:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap gap-3 text-sm" role="group" aria-label="Map layers">
              {TOGGLE_LABELS.map(([k, label]) => (
                <label key={k} className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={toggles[k]} onChange={() => setToggles((t) => toggle(t, k))} />
                  {label}
                </label>
              ))}
            </div>
            <div className="relative">
              <BaseMap className="h-[calc(100vh-320px)] min-h-[460px]">
                <FitToPoints points={fitPoints} fitKey={mapQ.loading || cmpQ.loading ? null : assignmentId} />
                {toggles.assignedRoute && <AssignedRouteLayer geometry={cmp?.assigned_geometry} />}
                {toggles.actualRoute && <TrailLayer track={trail} />}
                {toggles.actualRoute && <OffRouteLayer track={trail} segments={segments} activeIndex={segment} />}
                <PidStatusLayer pids={shownPids} selectedId={selected?.pid_id} onSelect={setSelected} />
                {isToday && <CurrentVehicleMarker position={vehiclePos?.pos} label={cmp?.vehicle?.vehicle_number} />}
                <FlyTo target={fly} zoom={17} />
              </BaseMap>
              <div className="absolute bottom-3 left-3 z-[400]"><CoverageLegend /></div>
              {(mapQ.loading || cmpQ.loading) && <div className="absolute right-3 top-3 z-[400] rounded bg-white/90 px-2 py-1 shadow"><Spinner /></div>}
            </div>
            <p className="text-xs text-slate-500">
              {shownPids.length} of {pids.length} PIDs shown{unavailable ? ` · ${unavailable} without coordinates (GPS data unavailable, not on map)` : ''}
              {mapQ.data?.truncated ? ` · list capped at ${mapQ.data.cap}` : ''}
            </p>
          </div>
          <div className="w-full xl:w-96">
            {cmp ? <ComparisonPanel data={cmp} counts={counts} activeSegment={segment} onSegment={onSegment} /> : <Spinner />}
          </div>
        </div>
      )}

      <Drawer open={Boolean(selected && assignmentMeta)} title={selected ? `PID ${selected.pid_number}` : ''} onClose={() => setSelected(null)}>
        {selected && assignmentMeta && <PidDetails pid={selected} assignment={assignmentMeta} canViewEvidence={can('visits:read')} />}
      </Drawer>
    </div>
  );
}
