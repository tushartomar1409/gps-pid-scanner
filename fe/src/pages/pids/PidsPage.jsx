import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MasterListPage, STATUS_OPTIONS } from '../masters/MasterListPage.jsx';
import { ZoneWardSelects } from '../masters/ZoneWardSelects.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { Button } from '../../components/Button.jsx';
import { useFormState, textOrNull, str, idOrNull } from '../../hooks/useFormState.js';
import { toOptions } from '../../hooks/useLookups.js';
import { usePermission } from '../../auth/usePermission.js';
import { pidsApi } from '../../api/resources.js';
import { COORD_STATUS_STYLES } from '../../utils/mapStyles.js';
import { FixLocationModal } from './FixLocationModal.jsx';
import { PidMapView } from './PidMapView.jsx';

const COORD_OPTIONS = Object.entries(COORD_STATUS_STYLES).map(([value, s]) => ({ value, label: s.label.replace(' (not on map)', '') }));
const HAS_COORDS_OPTIONS = [{ value: 'true', label: 'Has coordinates' }, { value: 'false', label: 'Missing coordinates' }];
const PID_RE = /^[A-Z0-9][A-Z0-9/_.-]{0,49}$/;

export function CoordBadge({ status }) {
  const s = COORD_STATUS_STYLES[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-700">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: s?.color }} aria-hidden="true" />
      {s ? s.label.replace(' (not on map)', '') : status}
    </span>
  );
}

function PidForm({ formId, initial, isEdit, lookups, serverErrors, onSubmit }) {
  const { values, setField, errorFor, handleSubmit } = useFormState(
    {
      pid_number: initial.pid_number ?? '',
      owner_name: initial.owner_name ?? '',
      mobile: initial.mobile ?? '',
      address: initial.address ?? '',
      zone_id: str(initial.zone_id),
      ward_id: str(initial.ward_id),
      status: initial.status ?? 'ACTIVE',
    },
    {
      validate: (v) => ({
        pid_number: !v.pid_number.trim() ? 'PID number is required' : !PID_RE.test(v.pid_number.trim().toUpperCase()) ? '1–50 chars: letters, digits, / _ . -' : null,
        ward_id: !v.ward_id ? 'Ward is required' : null,
        mobile: v.mobile.trim() && !/^[0-9+\- ]{7,15}$/.test(v.mobile.trim()) ? '7–15 digits; may include +, - and spaces' : null,
      }),
      toPayload: (v) => ({
        pid_number: v.pid_number.trim().toUpperCase(),
        owner_name: textOrNull(v.owner_name),
        mobile: textOrNull(v.mobile),
        address: textOrNull(v.address),
        ...(v.zone_id ? { zone_id: idOrNull(v.zone_id) } : {}),
        ward_id: Number(v.ward_id),
        ...(isEdit ? { status: v.status } : {}),
      }),
      onSubmit,
      serverErrors,
    },
  );
  return (
    <form id={formId} onSubmit={handleSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
      <Input label="PID number" required value={values.pid_number} onChange={(e) => setField('pid_number', e.target.value)} error={errorFor('pid_number')} />
      <Input label="Owner name" value={values.owner_name} onChange={(e) => setField('owner_name', e.target.value)} error={errorFor('owner_name')} />
      <ZoneWardSelects values={values} setField={setField} errorFor={errorFor} lookups={lookups} initial={initial} wardRequired />
      <Input label="Mobile" inputMode="tel" value={values.mobile} onChange={(e) => setField('mobile', e.target.value)} error={errorFor('mobile')} />
      <Input label="Address" value={values.address} onChange={(e) => setField('address', e.target.value)} error={errorFor('address')} />
      {isEdit && <Select label="Status" value={values.status} options={STATUS_OPTIONS} onChange={(e) => setField('status', e.target.value)} />}
      <p className="text-xs text-slate-500 sm:col-span-2">
        Coordinates are set with <strong>Fix location</strong> (map) or by import — every change is audited.
      </p>
    </form>
  );
}

function ViewToggle({ view, onChange }) {
  const btn = (v, label) => (
    <button
      type="button"
      onClick={() => onChange(v === 'table' ? '' : v)}
      aria-pressed={view === v}
      className={`px-3 py-1.5 text-sm font-medium ${view === v ? 'bg-emerald-700 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}
    >
      {label}
    </button>
  );
  return (
    <div className="inline-flex overflow-hidden rounded-md ring-1 ring-slate-300" role="group" aria-label="View">
      {btn('table', 'Table')}
      {btn('map', 'Map')}
    </div>
  );
}

export default function PidsPage() {
  const can = usePermission();
  const canWrite = can('pids:write');
  const [fixing, setFixing] = useState(null);
  const [missingCount, setMissingCount] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const refetchRef = useRef(null);

  const loadMissing = useCallback(() => {
    pidsApi.list({ has_coords: 'false', status: 'ACTIVE', limit: 1 }).then(({ pagination }) => setMissingCount(pagination?.total ?? 0)).catch(() => setMissingCount(null));
  }, []);
  useEffect(loadMissing, [loadMissing, reloadToken]);

  const config = {
    title: 'PIDs',
    description: 'Registered properties and their coordinates.',
    singular: 'PID',
    permission: 'pids',
    labelKey: 'pid_number',
    api: pidsApi,
    lookupTypes: ['zones', 'wards', 'routes'],
    searchPlaceholder: 'PID number or address',
    extraKeys: ['view'],
    filters: [
      { key: 'zone_id', label: 'Zone', type: 'select', options: (l) => toOptions(l.zones) },
      { key: 'ward_id', label: 'Ward', type: 'select', dependsOn: 'zone_id', options: (l, p) => toOptions((l.wards || []).filter((w) => !p.zone_id || String(w.zone_id) === p.zone_id)) },
      { key: 'route_id', label: 'Route', type: 'select', options: (l, p) => toOptions((l.routes || []).filter((r) => (!p.zone_id || String(r.zone_id) === p.zone_id) && (!p.ward_id || String(r.ward_id) === p.ward_id))) },
      { key: 'coord_status', label: 'Coordinates', type: 'select', options: () => COORD_OPTIONS },
      { key: 'has_coords', label: 'Has coordinates', type: 'select', options: () => HAS_COORDS_OPTIONS },
      { key: 'status', label: 'Status', type: 'select', options: () => STATUS_OPTIONS },
    ],
    columns: [
      { key: 'pid_number', header: 'PID', render: (r) => <span className="font-mono text-xs font-semibold">{r.pid_number}</span> },
      { key: 'address', header: 'Address', render: (r) => <span className="block max-w-xs truncate" title={r.address || ''}>{r.address || '—'}</span> },
      { key: 'zone_name', header: 'Zone' },
      { key: 'ward_name', header: 'Ward' },
      { key: 'coord_status', header: 'Coordinates', render: (r) => <CoordBadge status={r.coord_status} /> },
      { key: 'route_count', header: 'Routes' },
    ],
    Form: PidForm,
    conflictMessages: { pids_pid_number_key: 'A PID with this number already exists' },
    extraRowActions: (r, { refetch }) => (
      <Button variant="ghost" size="sm" onClick={() => { refetchRef.current = refetch; setFixing(r); }}>Fix location</Button>
    ),
    renderToolbar: ({ params, setParams }) => (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {missingCount > 0 && (
            <button
              type="button"
              onClick={() => setParams({ has_coords: params.has_coords === 'false' ? '' : 'false', view: '' })}
              aria-pressed={params.has_coords === 'false'}
              className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${params.has_coords === 'false' ? 'bg-amber-600 text-white ring-amber-600' : 'bg-amber-50 text-amber-900 ring-amber-300 hover:bg-amber-100'}`}
            >
              Missing coordinates ({missingCount})
            </button>
          )}
          {canWrite && <Link to="/pids/import" className="text-sm font-medium text-emerald-700 hover:underline">Import PIDs…</Link>}
        </div>
        <ViewToggle view={params.view === 'map' ? 'map' : 'table'} onChange={(v) => setParams({ view: v }, { resetPage: false })} />
      </div>
    ),
    renderAlternateView: ({ params }) =>
      params.view === 'map' ? <PidMapView key={reloadToken} params={params} canWrite={canWrite} onFixLocation={setFixing} /> : null,
  };

  return (
    <>
      <MasterListPage config={config} />
      {fixing && (
        <FixLocationModal
          pid={fixing}
          onClose={() => setFixing(null)}
          onSaved={() => {
            setFixing(null);
            setReloadToken((t) => t + 1); // remounts the map view + reloads the missing count
            refetchRef.current?.();
          }}
        />
      )}
    </>
  );
}
