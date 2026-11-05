import { useEffect, useState } from 'react';
import { DataTable } from '../../components/DataTable.jsx';
import { Spinner } from '../../components/Spinner.jsx';
import { ErrorState } from '../../components/ErrorState.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { BaseMap } from '../../components/map/BaseMap.jsx';
import { FitToPoints } from '../../components/map/MapHelpers.jsx';
import { PidPointsLayer } from '../../components/map/PidPointsLayer.jsx';
import { assignmentsApi } from '../../api/resources.js';
import { parseApiError } from '../../utils/apiErrors.js';
import { formatShift, formatOpDate } from '../../utils/dates.js';
import { CoverageBar } from './CoverageBar.jsx';
import { Link } from 'react-router-dom';
import { Disclaimer } from '../../components/Disclaimer.jsx';
import { VISIT_STATUS, VISIT_STATUS_ORDER } from '../../utils/visitStatus.js';
import { usePermission } from '../../auth/usePermission.js';

// One status/colour map for the whole app (GUIDE #9 A4).
const VISIT_LABELS = Object.fromEntries(VISIT_STATUS_ORDER.map((k) => [k, VISIT_STATUS[k].label]));
const VISIT_COLORS = Object.fromEntries(VISIT_STATUS_ORDER.map((k) => [k, VISIT_STATUS[k].color]));

export function AssignmentDetail({ id, renderMap = true }) {
  const can = usePermission();
  const [page, setPage] = useState(1);
  const [visitStatus, setVisitStatus] = useState('');
  const [state, setState] = useState({ data: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    assignmentsApi
      .get(id, { page, limit: 50, visit_status: visitStatus })
      .then(({ data }) => !cancelled && setState({ data, loading: false, error: null }))
      .catch((err) => !cancelled && setState({ data: null, loading: false, error: parseApiError(err).message }));
    return () => {
      cancelled = true;
    };
  }, [id, page, visitStatus]);

  const { data, loading, error } = state;
  if (error) return <ErrorState message={error} />;
  if (!data) return <div className="flex justify-center py-12"><Spinner /></div>;

  const mapPoints = data.pids
    .filter((p) => p.pid_latitude != null)
    .map((p) => ({ id: p.pid_id, pid_number: p.pid_number, latitude: p.pid_latitude, longitude: p.pid_longitude, visit_status: p.visit_status }));

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-slate-500">Date</dt><dd>{formatOpDate(data.operational_date)}</dd>
        <dt className="text-slate-500">Route</dt><dd>{data.route_code} — {data.route_name}</dd>
        <dt className="text-slate-500">Vehicle</dt><dd>{data.vehicle_number}</dd>
        <dt className="text-slate-500">Agency</dt><dd>{data.agency_name || '—'}</dd>
        <dt className="text-slate-500">Shift (IST)</dt><dd>{formatShift(data)}</dd>
        <dt className="text-slate-500">Status</dt><dd><StatusBadge status={data.status} /></dd>
        <dt className="text-slate-500">Coverage</dt><dd><CoverageBar row={data} /></dd>
      </dl>
      <p className="text-xs text-slate-500">This is the frozen PID snapshot taken when the assignment was created.</p>
      <Disclaimer />
      {can('assignments:read') && (
        <Link to={`/coverage?date=${data.operational_date}&assignment=${id}`} className="text-sm font-medium text-emerald-700 hover:underline">Open coverage map</Link>
      )}
      {renderMap && mapPoints.length > 0 && (
        <BaseMap className="h-64">
          <FitToPoints points={mapPoints.map((p) => [p.latitude, p.longitude])} fitKey={`${id}|${page}|${visitStatus}`} />
          <PidPointsLayer points={mapPoints} styleFor={(p) => ({ color: VISIT_COLORS[p.visit_status] || '#2563eb' })} />
        </BaseMap>
      )}
      <div className="flex items-center gap-2 text-sm">
        <label htmlFor="visit-filter" className="text-slate-600">Status</label>
        <select id="visit-filter" value={visitStatus} onChange={(e) => { setVisitStatus(e.target.value); setPage(1); }} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
          <option value="">All</option>
          {Object.entries(VISIT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {loading && <Spinner label="" />}
      </div>
      <DataTable
        rowKey="pid_id"
        rows={data.pids}
        loading={loading}
        pagination={data.pids_pagination}
        onPageChange={setPage}
        columns={[
          { key: 'pid_number', header: 'PID', render: (p) => <span className="font-mono text-xs">{p.pid_number}</span> },
          { key: 'address', header: 'Address', render: (p) => <span className="block max-w-[14rem] truncate">{p.address || '—'}</span> },
          {
            key: 'visit_status', header: 'Status', render: (p) => (
              <span className="inline-flex items-center gap-1.5 text-xs">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: VISIT_COLORS[p.visit_status] }} aria-hidden="true" />
                <span aria-hidden="true">{VISIT_STATUS[p.visit_status]?.symbol}</span> {VISIT_LABELS[p.visit_status] || p.visit_status}
              </span>
            ),
          },
        ]}
        emptyTitle="No PIDs match"
      />
    </div>
  );
}
