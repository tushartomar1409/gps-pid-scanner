// Two-panel route builder (GUIDE #5 C): form + start/end on the left, ward PID map on the right,
// selected PID list below. Click a PID to toggle, Shift+drag to box-select, draw an optional line.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CircleMarker, Polyline, Tooltip } from 'react-leaflet';
import { Button } from '../../components/Button.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { Spinner } from '../../components/Spinner.jsx';
import { ErrorState } from '../../components/ErrorState.jsx';
import { UnsavedChangesDialog } from '../../components/UnsavedChangesDialog.jsx';
import { useToast } from '../../components/Toast.jsx';
import { BaseMap } from '../../components/map/BaseMap.jsx';
import { BoxSelect, FitToPoints, MapClick } from '../../components/map/MapHelpers.jsx';
import { PidPointsLayer } from '../../components/map/PidPointsLayer.jsx';
import { MapLegend } from '../../components/map/MapLegend.jsx';
import { STATUS_OPTIONS } from '../masters/MasterListPage.jsx';
import { useLookups, toOptions } from '../../hooks/useLookups.js';
import { useUnsavedChangesPrompt } from '../../hooks/useUnsavedChangesPrompt.js';
import { usePermission } from '../../auth/usePermission.js';
import { pidsApi, routesApi } from '../../api/resources.js';
import { parseApiError } from '../../utils/apiErrors.js';
import { MUTED_STYLE, ROUTE_LINE_COLOR, SELECTION_STYLE } from '../../utils/mapStyles.js';
import {
  toggleId, addPointsWhere, saveRouteAndPids, buildRoutePayload, validateRouteForm, MAX_ASSIGN,
} from './routeBuilderLogic.js';

const EMPTY_FORM = { route_code: '', route_name: '', zone_id: '', ward_id: '', agency_id: '', default_vehicle_id: '', status: 'ACTIVE' };
const WORLD = '-180,-90,180,90';
const s = (v) => (v == null ? '' : String(v));

/** Loads every PID of a route (all pages), including ones without coordinates. */
async function loadAllRoutePids(routeId) {
  const first = await routesApi.pids(routeId, { page: 1, limit: 100 });
  const rows = [...first.data];
  const pages = first.pagination?.total_pages || 1;
  for (let p = 2; p <= pages; p += 5) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(5, pages - p + 1) }, (_, i) => routesApi.pids(routeId, { page: p + i, limit: 100 })),
    );
    for (const b of batch) rows.push(...b.data);
  }
  return rows;
}

const MODES = [
  { key: 'select', label: 'Select PIDs', hint: 'Click a PID to add/remove it. Shift + drag to select all PIDs in a box.' },
  { key: 'start', label: 'Set start', hint: 'Click the map to set the route start point.' },
  { key: 'end', label: 'Set end', hint: 'Click the map to set the route end point.' },
  { key: 'draw', label: 'Draw line', hint: 'Click to add points to the route line. Use Undo / Clear to edit.' },
];

export default function RouteBuilderPage() {
  const { id: idParam } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const can = usePermission();
  const canWrite = can('routes:write');
  const lookups = useLookups(['zones', 'wards', 'agencies', 'vehicles']);

  const [routeId, setRouteId] = useState(idParam === 'new' ? null : Number(idParam));
  const loadedFor = useRef(null);
  const [loading, setLoading] = useState(idParam !== 'new');
  const [loadError, setLoadError] = useState('');

  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [start, setStart] = useState(null); // [lat, lng]
  const [end, setEnd] = useState(null);
  const [line, setLine] = useState([]); // [[lat, lng], ...]
  const [selected, setSelected] = useState(new Set());
  const [savedIds, setSavedIds] = useState([]);
  const [pidInfo, setPidInfo] = useState(new Map()); // id -> { pid_number, latitude, longitude }
  const [mode, setMode] = useState('select');
  const [listSearch, setListSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [pidsSaveError, setPidsSaveError] = useState('');
  const [baseline, setBaseline] = useState(null);

  const [wardPoints, setWardPoints] = useState([]);
  const [wardTruncated, setWardTruncated] = useState(false);
  const [wardLoading, setWardLoading] = useState(false);

  const mergeInfo = useCallback((rows) => {
    setPidInfo((m) => {
      const next = new Map(m);
      for (const r of rows) next.set(r.id, { pid_number: r.pid_number, latitude: r.latitude, longitude: r.longitude });
      return next;
    });
  }, []);

  // ---- load existing route (once per id; skipped right after we created it ourselves)
  useEffect(() => {
    if (idParam === 'new' || loadedFor.current === Number(idParam)) return;
    loadedFor.current = Number(idParam);
    let cancelled = false;
    setLoading(true);
    Promise.all([routesApi.get(idParam), loadAllRoutePids(idParam)])
      .then(([{ data: r }, pids]) => {
        if (cancelled) return;
        const f = {
          route_code: r.route_code, route_name: r.route_name, zone_id: s(r.zone_id), ward_id: s(r.ward_id),
          agency_id: s(r.agency_id), default_vehicle_id: s(r.default_vehicle_id), status: r.status,
        };
        const st = r.start_latitude != null ? [r.start_latitude, r.start_longitude] : null;
        const en = r.end_latitude != null ? [r.end_latitude, r.end_longitude] : null;
        const ln = r.route_geometry?.coordinates?.map(([lng, lat]) => [lat, lng]) || [];
        const ids = pids.map((p) => p.id);
        setForm(f);
        setStart(st);
        setEnd(en);
        setLine(ln);
        setSelected(new Set(ids));
        setSavedIds(ids);
        mergeInfo(pids);
        setBaseline(JSON.stringify({ f, st, en, ln, ids: [...ids].sort() }));
        setRouteId(r.id);
        setLoading(false);
      })
      .catch((err) => !cancelled && (setLoadError(parseApiError(err).message), setLoading(false)));
    return () => {
      cancelled = true;
    };
  }, [idParam, mergeInfo]);

  useEffect(() => {
    if (idParam === 'new') setBaseline(JSON.stringify({ f: EMPTY_FORM, st: null, en: null, ln: [], ids: [] }));
  }, [idParam]);

  // ---- ward PIDs for the map (one call: whole ward, coordinates only)
  useEffect(() => {
    if (!form.ward_id) {
      setWardPoints([]);
      return undefined;
    }
    let cancelled = false;
    setWardLoading(true);
    pidsApi
      .map({ bbox: WORLD, ward_id: form.ward_id, limit: 10000 })
      .then(({ data }) => {
        if (cancelled) return;
        setWardPoints(data.points);
        setWardTruncated(data.truncated);
        mergeInfo(data.points);
      })
      .catch((err) => !cancelled && toast.error(parseApiError(err).message))
      .finally(() => !cancelled && setWardLoading(false));
    return () => {
      cancelled = true;
    };
  }, [form.ward_id, mergeInfo, toast]);

  const current = JSON.stringify({ f: form, st: start, en: end, ln: line, ids: [...selected].sort() });
  const dirty = baseline !== null && current !== baseline;
  const { blocker, allowNextNavigation } = useUnsavedChangesPrompt(dirty && canWrite);

  const setField = (k, v) => {
    setErrors((e) => ({ ...e, [k]: undefined }));
    setForm((f) => {
      const next = { ...f, [k]: v };
      if (k === 'zone_id') {
        const w = (lookups.data.wards || []).find((x) => String(x.id) === f.ward_id);
        if (w && String(w.zone_id) !== v) next.ward_id = '';
      }
      if (k === 'ward_id' && v) {
        const w = (lookups.data.wards || []).find((x) => String(x.id) === v);
        if (w) next.zone_id = String(w.zone_id);
      }
      if (k === 'agency_id') {
        const veh = (lookups.data.vehicles || []).find((x) => String(x.id) === f.default_vehicle_id);
        if (veh && v && String(veh.agency_id) !== v) next.default_vehicle_id = '';
      }
      return next;
    });
    if (k === 'ward_id' && v !== form.ward_id && selected.size) {
      setSelected(new Set());
      toast.info('Ward changed — PID selection cleared (route PIDs must be in the route’s ward).');
    }
  };

  const onMapClick = (latlng) => {
    if (mode === 'start') setStart([latlng.lat, latlng.lng]);
    else if (mode === 'end') setEnd([latlng.lat, latlng.lng]);
    else if (mode === 'draw') setLine((l) => [...l, [latlng.lat, latlng.lng]]);
  };
  const onPointClick = (p) => mode === 'select' && setSelected((sel) => toggleId(sel, p.id));
  const onBox = (bounds) => setSelected((sel) => addPointsWhere(sel, wardPoints, (lat, lng) => bounds.contains([lat, lng])));

  const styleFor = useCallback((p) => (selected.has(p.id)
    ? { color: SELECTION_STYLE.color, radius: 6 }
    : { color: MUTED_STYLE.color, radius: 4, fillOpacity: 0.6 }), [selected]);

  const fitPoints = useMemo(() => {
    const pts = [...wardPoints.map((p) => [p.latitude, p.longitude]), ...line, ...(start ? [start] : []), ...(end ? [end] : [])];
    return pts;
  }, [wardPoints, line, start, end]);

  const save = async () => {
    const found = validateRouteForm(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    setPidsSaveError('');
    const selectedIds = [...selected];
    const res = await saveRouteAndPids({
      api: routesApi, routeId, payload: buildRoutePayload(form, { start, end, line, isEdit: Boolean(routeId) }), selectedIds, savedIds,
    });
    setSaving(false);

    if (res.failedStep === 'route') {
      setErrors(res.error.fieldErrors || {});
      toast.error(res.error.status === 409 ? 'Route code already exists, or the route cannot move ward while it has PIDs.' : res.error.message);
      return;
    }
    if (!routeId) {
      // Keep this component instance (and the selection) — don't reload from the server.
      loadedFor.current = res.routeId;
      setRouteId(res.routeId);
      allowNextNavigation(); // our own /routes/new -> /routes/:id redirect must not trigger the guard
      navigate(`/routes/${res.routeId}`, { replace: true });
    }
    const f = { ...form, route_code: res.route.route_code };
    setForm(f);
    if (res.failedStep === 'pids') {
      setPidsSaveError(`The route was saved, but its PID list was NOT saved: ${res.error.message}`);
      setBaseline(JSON.stringify({ f, st: start, en: end, ln: line, ids: [...savedIds].sort() }));
      return;
    }
    setSavedIds(selectedIds);
    setBaseline(JSON.stringify({ f, st: start, en: end, ln: line, ids: [...selectedIds].sort() }));
    toast.success(`Route ${res.route.route_code} saved${res.pidsResult ? ` with ${res.pidsResult.total} PIDs` : ''}`);
  };

  if (loading) return <div className="flex justify-center py-16"><Spinner label="Loading route…" /></div>;
  if (loadError) return <ErrorState title="Could not load route" message={loadError} />;

  const wards = (lookups.data.wards || []).filter((w) => !form.zone_id || String(w.zone_id) === form.zone_id);
  const vehicles = (lookups.data.vehicles || []).filter((v) => !form.agency_id || String(v.agency_id) === form.agency_id);
  const selectedList = [...selected]
    .map((id) => ({ id, ...(pidInfo.get(id) || { pid_number: `#${id}` }) }))
    .filter((p) => !listSearch || p.pid_number.toLowerCase().includes(listSearch.toLowerCase()))
    .sort((a, b) => a.pid_number.localeCompare(b.pid_number));
  const activeMode = MODES.find((m) => m.key === mode);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/routes" className="text-sm text-emerald-700 hover:underline">← Routes</Link>
          <h1 className="text-xl font-semibold text-slate-900">{routeId ? `Route ${form.route_code}` : 'New route'}</h1>
          <p className="text-xs text-slate-500">Editing this route does not change assignments already created for past or current dates.</p>
        </div>
        {canWrite && (
          <div className="flex items-center gap-3">
            {dirty && <span className="text-xs font-medium text-amber-700">Unsaved changes</span>}
            <Button onClick={save} loading={saving}>{routeId ? 'Save route' : 'Create route'}</Button>
          </div>
        )}
      </div>

      {pidsSaveError && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          <span>{pidsSaveError} Your selection is kept.</span>
          <Button size="sm" variant="secondary" onClick={save} loading={saving}>Retry</Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* Left: form */}
        <fieldset disabled={!canWrite} className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <Input label="Route code" required value={form.route_code} onChange={(e) => setField('route_code', e.target.value)} error={errors.route_code} hint="Stored in upper case, e.g. ROUTE001" />
          <Input label="Route name" required value={form.route_name} onChange={(e) => setField('route_name', e.target.value)} error={errors.route_name} />
          <Select label="Zone" placeholder="Select zone" value={form.zone_id} options={toOptions(lookups.data.zones)} onChange={(e) => setField('zone_id', e.target.value)} error={errors.zone_id} />
          <Select label="Ward" required placeholder="Select ward" value={form.ward_id} options={toOptions(wards)} onChange={(e) => setField('ward_id', e.target.value)} error={errors.ward_id} />
          <Select label="Agency" placeholder="No agency" value={form.agency_id} options={toOptions(lookups.data.agencies)} onChange={(e) => setField('agency_id', e.target.value)} error={errors.agency_id} />
          <Select label="Default vehicle" placeholder="None" value={form.default_vehicle_id} options={vehicles.map((v) => ({ value: String(v.id), label: v.name }))} onChange={(e) => setField('default_vehicle_id', e.target.value)} error={errors.default_vehicle_id} hint={form.agency_id ? 'Vehicles of the selected agency' : undefined} />
          {routeId && <Select label="Status" value={form.status} options={STATUS_OPTIONS} onChange={(e) => setField('status', e.target.value)} />}
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
            <div>
              <p className="font-medium text-slate-700">Start point</p>
              <p>{start ? `${start[0].toFixed(5)}, ${start[1].toFixed(5)}` : 'Not set'}</p>
              {start && <button type="button" className="text-red-700 hover:underline" onClick={() => setStart(null)}>Clear</button>}
            </div>
            <div>
              <p className="font-medium text-slate-700">End point</p>
              <p>{end ? `${end[0].toFixed(5)}, ${end[1].toFixed(5)}` : 'Not set'}</p>
              {end && <button type="button" className="text-red-700 hover:underline" onClick={() => setEnd(null)}>Clear</button>}
            </div>
          </div>
          <p className="text-xs text-slate-600">Route line: {line.length ? `${line.length} point(s)${line.length < 2 ? ' — needs at least 2 to be saved' : ''}` : 'none'}</p>
        </fieldset>

        {/* Right: map */}
        <div className="flex flex-col gap-2">
          {canWrite && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex overflow-hidden rounded-md ring-1 ring-slate-300" role="group" aria-label="Map tool">
                {MODES.map((m) => (
                  <button key={m.key} type="button" aria-pressed={mode === m.key} onClick={() => setMode(m.key)}
                    className={`px-3 py-1.5 text-sm font-medium ${mode === m.key ? 'bg-emerald-700 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>
                    {m.label}
                  </button>
                ))}
              </div>
              {mode === 'draw' && (
                <>
                  <Button size="sm" variant="secondary" disabled={!line.length} onClick={() => setLine((l) => l.slice(0, -1))}>Undo point</Button>
                  <Button size="sm" variant="secondary" disabled={!line.length} onClick={() => setLine([])}>Clear line</Button>
                </>
              )}
              {mode === 'select' && (
                <>
                  <Button size="sm" variant="secondary" disabled={!wardPoints.length} onClick={() => setSelected((sel) => addPointsWhere(sel, wardPoints, () => true))}>Select all in ward</Button>
                  <Button size="sm" variant="secondary" disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear selection</Button>
                </>
              )}
            </div>
          )}
          <p className="text-xs text-slate-500">{form.ward_id ? activeMode.hint : 'Choose a ward to see its PIDs on the map.'}</p>
          {wardTruncated && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">This ward has more than 10,000 PIDs with coordinates; only the first 10,000 are shown.</p>}
          <div className="relative">
            <BaseMap className="h-[520px]">
              <MapClick onClick={onMapClick} />
              {canWrite && mode === 'select' && <BoxSelect onSelect={onBox} />}
              <FitToPoints points={fitPoints} fitKey={`${form.ward_id}|${routeId}|${wardPoints.length > 0}`} />
              <PidPointsLayer points={wardPoints} onPointClick={canWrite ? onPointClick : undefined} styleFor={styleFor} />
              {line.length > 0 && <Polyline positions={line} pathOptions={{ color: ROUTE_LINE_COLOR, weight: 4, opacity: 0.8 }} />}
              {start && <CircleMarker center={start} radius={9} pathOptions={{ color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 }}><Tooltip permanent direction="top">Start</Tooltip></CircleMarker>}
              {end && <CircleMarker center={end} radius={9} pathOptions={{ color: '#fff', weight: 2, fillColor: '#dc2626', fillOpacity: 1 }}><Tooltip permanent direction="top">End</Tooltip></CircleMarker>}
            </BaseMap>
            <MapLegend
              className="absolute bottom-4 left-3 z-[400]"
              title="Route builder"
              items={[{ key: 'sel', ...SELECTION_STYLE }, { key: 'mut', ...MUTED_STYLE }, { key: 'start', color: '#16a34a', label: 'Start' }, { key: 'end', color: '#dc2626', label: 'End' }]}
            />
            {wardLoading && <div className="absolute right-3 top-3 z-[400] rounded bg-white/90 px-2 py-1 shadow"><Spinner label="Loading ward PIDs…" /></div>}
          </div>
        </div>
      </div>

      {/* Selected PID list */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-800">
            Route PIDs: {selected.size} selected{selected.size > MAX_ASSIGN ? ` (max ${MAX_ASSIGN} per save)` : ''}
          </h2>
          <div className="w-64"><Input label="Search selected" type="search" value={listSearch} onChange={(e) => setListSearch(e.target.value)} /></div>
        </div>
        {selectedList.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">{selected.size ? 'No selected PID matches the search.' : 'No PIDs selected yet. Click PIDs on the map or Shift+drag a box.'}</p>
        ) : (
          <ul className="grid max-h-72 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-4" aria-label="Selected PIDs">
            {selectedList.slice(0, 400).map((p) => (
              <li key={p.id} className="flex items-center justify-between rounded border border-slate-200 px-2 py-1 text-xs">
                <span className="font-mono">{p.pid_number}{p.latitude == null ? ' (no coords)' : ''}</span>
                {canWrite && (
                  <button type="button" className="text-red-700 hover:underline" aria-label={`Remove ${p.pid_number}`} onClick={() => setSelected((sel) => toggleId(sel, p.id))}>Remove</button>
                )}
              </li>
            ))}
          </ul>
        )}
        {selectedList.length > 400 && <p className="mt-2 text-xs text-slate-500">Showing 400 of {selectedList.length}; use search to find others.</p>}
      </section>
      <UnsavedChangesDialog blocker={blocker} />
    </div>
  );
}
