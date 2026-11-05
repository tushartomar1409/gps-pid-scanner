// Daily route assignments (GUIDE #5 D, flow.txt §9).
import { useMemo, useState } from 'react';
import { Button } from '../../components/Button.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { Modal } from '../../components/Modal.jsx';
import { Drawer } from '../../components/Drawer.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { useToast } from '../../components/Toast.jsx';
import { usePermission } from '../../auth/usePermission.js';
import { useListParams } from '../../hooks/useListParams.js';
import { usePaginatedQuery } from '../../hooks/usePaginatedQuery.js';
import { useLookups, toOptions } from '../../hooks/useLookups.js';
import { assignmentsApi } from '../../api/resources.js';
import { parseApiError } from '../../utils/apiErrors.js';
import { todayIST, formatShift, formatOpDate } from '../../utils/dates.js';
import { AssignmentForm } from './AssignmentForm.jsx';
import { CopyDayModal } from './CopyDayModal.jsx';
import { AssignmentDetail } from './AssignmentDetail.jsx';
import { CoverageBar } from './CoverageBar.jsx';

const FILTER_KEYS = ['operational_date', 'zone_id', 'ward_id', 'agency_id', 'vehicle_id', 'route_id', 'status'];
const STATUS_OPTIONS = ['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED'].map((s) => ({ value: s, label: s[0] + s.slice(1).toLowerCase() }));

/** Server rule mirrors (the server stays authoritative and its 409 message is shown). */
export const canCancel = (r) => r.status === 'PLANNED' || r.status === 'ACTIVE';
export const canResnapshot = (r) => r.status === 'PLANNED';

/** Server error -> one readable sentence (message + first detail). */
export function describeError(err) {
  const e = parseApiError(err);
  const detail = Object.values(e.fieldErrors)[0];
  return detail && detail !== e.message ? `${e.message}. ${detail}` : e.message;
}

export default function AssignmentsPage() {
  const toast = useToast();
  const can = usePermission();
  const canWrite = can('assignments:write');
  const lookups = useLookups(['zones', 'wards', 'agencies', 'routes', 'vehicles']);
  const { params, setParams, setPage } = useListParams(FILTER_KEYS);
  const date = params.operational_date || todayIST();

  const query = useMemo(() => ({ ...params, operational_date: date, limit: 20 }), [params, date]);
  const { rows, pagination, loading, error, refetch } = usePaginatedQuery(assignmentsApi.list, query);

  const [creating, setCreating] = useState(false);
  const [createErrors, setCreateErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [viewId, setViewId] = useState(null);
  const [confirm, setConfirm] = useState(null); // { type: 'cancel'|'resnapshot', row }
  const [acting, setActing] = useState(false);

  const create = async (body) => {
    setSubmitting(true);
    setCreateErrors({});
    try {
      await assignmentsApi.create(body);
      toast.success('Assignment created');
      setCreating(false);
      if (body.operational_date !== date) setParams({ operational_date: body.operational_date });
      else refetch();
    } catch (err) {
      setCreateErrors(parseApiError(err).fieldErrors);
      toast.error(describeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const act = async () => {
    setActing(true);
    try {
      if (confirm.type === 'cancel') await assignmentsApi.cancel(confirm.row.id);
      else await assignmentsApi.resnapshot(confirm.row.id);
      toast.success(confirm.type === 'cancel' ? 'Assignment cancelled' : 'PID snapshot refreshed from the current route');
      setConfirm(null);
      refetch();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setActing(false);
    }
  };

  const l = lookups.data;
  const columns = [
    { key: 'operational_date', header: 'Date', render: (r) => formatOpDate(r.operational_date) },
    { key: 'route_code', header: 'Route', render: (r) => <span title={r.route_name}><span className="font-mono text-xs font-semibold">{r.route_code}</span><span className="block text-xs text-slate-500">{r.ward_name}</span></span> },
    { key: 'vehicle_number', header: 'Vehicle', render: (r) => <span className="font-mono text-xs">{r.vehicle_number}</span> },
    { key: 'agency_name', header: 'Agency' },
    { key: 'shift', header: 'Shift (IST)', render: formatShift },
    { key: 'assigned_pid_count', header: 'PIDs' },
    { key: 'coverage', header: 'Coverage', render: (r) => <CoverageBar row={r} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: '_actions', header: <span className="sr-only">Actions</span>, className: 'text-right',
      render: (r) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setViewId(r.id)}>View</Button>
          {canWrite && canResnapshot(r) && <Button variant="ghost" size="sm" onClick={() => setConfirm({ type: 'resnapshot', row: r })}>Re-snapshot</Button>}
          {canWrite && canCancel(r) && <Button variant="ghost" size="sm" className="text-red-700" onClick={() => setConfirm({ type: 'cancel', row: r })}>Cancel</Button>}
        </div>
      ),
    },
  ];

  const filterSelect = (key, label, options) => (
    <Select key={key} label={label} placeholder="All" value={params[key]} options={options}
      onChange={(e) => setParams({ [key]: e.target.value, ...(key === 'zone_id' ? { ward_id: '', route_id: '' } : {}), ...(key === 'ward_id' ? { route_id: '' } : {}) })} />
  );

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Daily route assignments</h1>
          <p className="text-sm text-slate-500">Vehicles mapped to routes per operational date (IST). Each assignment keeps a frozen PID snapshot.</p>
        </div>
        {canWrite && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setCopying(true)}>Copy from another day</Button>
            <Button onClick={() => { setCreateErrors({}); setCreating(true); }}>Create assignment</Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <Input label="Date" type="date" value={date} onChange={(e) => setParams({ operational_date: e.target.value })} />
        {filterSelect('zone_id', 'Zone', toOptions(l.zones))}
        {filterSelect('ward_id', 'Ward', toOptions((l.wards || []).filter((w) => !params.zone_id || String(w.zone_id) === params.zone_id)))}
        {filterSelect('agency_id', 'Agency', toOptions(l.agencies))}
        {filterSelect('route_id', 'Route', (l.routes || []).filter((r) => (!params.zone_id || String(r.zone_id) === params.zone_id) && (!params.ward_id || String(r.ward_id) === params.ward_id)).map((r) => ({ value: String(r.id), label: r.code })))}
        {filterSelect('vehicle_id', 'Vehicle', (l.vehicles || []).filter((v) => !params.agency_id || String(v.agency_id) === params.agency_id).map((v) => ({ value: String(v.id), label: v.name })))}
        {filterSelect('status', 'Status', STATUS_OPTIONS)}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        pagination={pagination}
        onPageChange={setPage}
        emptyTitle={`No assignments for ${formatOpDate(date)}`}
        emptyMessage={canWrite ? 'Create one, or copy the previous day’s assignments.' : undefined}
      />

      <Modal
        open={creating}
        title="Create assignment"
        onClose={submitting ? undefined : () => setCreating(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)} disabled={submitting}>Cancel</Button>
            <Button type="submit" form="assignment-form" loading={submitting}>Create</Button>
          </>
        }
      >
        {creating && <AssignmentForm formId="assignment-form" lookups={l} defaultDate={date} serverErrors={createErrors} onSubmit={create} />}
      </Modal>

      {copying && <CopyDayModal lookups={l} defaultTarget={date} onClose={() => setCopying(false)} onDone={refetch} />}

      <Drawer open={viewId !== null} title="Assignment details" onClose={() => setViewId(null)}>
        {viewId !== null && <AssignmentDetail id={viewId} />}
      </Drawer>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.type === 'cancel' ? 'Cancel this assignment?' : 'Refresh PID snapshot?'}
        message={confirm?.type === 'cancel'
          ? `${confirm.row.route_code} / ${confirm.row.vehicle_number} on ${formatOpDate(confirm.row.operational_date)} will be cancelled. Cancelled assignments are kept for history and are not copied.`
          : `The PID list of ${confirm?.row.route_code} on ${formatOpDate(confirm?.row.operational_date)} will be rebuilt from the route's current PIDs and coordinates. Only possible before any GPS activity.`}
        confirmLabel={confirm?.type === 'cancel' ? 'Cancel assignment' : 'Refresh snapshot'}
        variant={confirm?.type === 'cancel' ? 'danger' : 'primary'}
        busy={acting}
        onConfirm={act}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
