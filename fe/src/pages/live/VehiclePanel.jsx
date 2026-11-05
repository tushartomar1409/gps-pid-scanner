// Side panel for one vehicle (flow §10), from GET /gps/live-vehicles/:id. Counts refresh on a
// pid:status that touches this vehicle's assignment.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { gpsApi } from '../../api/resources.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { useSocketEvent } from '../../realtime/hooks.js';
import { Spinner } from '../../components/Spinner.jsx';
import { Disclaimer } from '../../components/Disclaimer.jsx';
import { CONNECTION_STATUS, VISIT_STATUS } from '../../utils/visitStatus.js';
import { COVERAGE_LABELS } from '../../utils/disclaimer.js';
import { formatDateTime } from '../../utils/format.js';
import { todayIST } from '../../utils/dates.js';
import { agoLabel } from './liveStore.js';

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const Row = ({ k, v }) => (
  <div className="flex justify-between gap-3 py-1 text-sm">
    <dt className="text-slate-500">{k}</dt>
    <dd className="text-right font-medium text-slate-800 tabular-nums">{v ?? '—'}</dd>
  </div>
);

export function VehiclePanel({ vehicleId, live, onClose }) {
  const now = useNow();
  const q = useApiQuery((signal) => gpsApi.liveVehicle(vehicleId, { signal }).then((r) => r.data), vehicleId);
  const d = q.data;
  const { reload } = q;
  useSocketEvent('pid:status', (p) => {
    if (p?.assignments?.some((a) => a.vehicle_id === vehicleId)) reload();
  });

  // Position/time from the live store (ticks with deltas); everything else from the detail call.
  const recordedAt = live?.recorded_at ?? d?.recorded_at;
  const status = CONNECTION_STATUS[live?.connection_status ?? d?.connection_status] || CONNECTION_STATUS.NO_DATA;
  const t = d?.today;
  const assignmentId = t?.assignments?.[0]?.route_assignment_id;

  return (
    <aside className="flex w-full flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm lg:w-80" aria-label="Vehicle details">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{live?.vehicle_number ?? d?.vehicle_number ?? 'Vehicle'}</h2>
          <p className="flex items-center gap-1.5 text-xs text-slate-600">
            <span className="inline-block h-2.5 w-2.5 rounded-full border" style={{ background: status.fill, borderColor: status.stroke }} aria-hidden="true" />
            {status.label}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Close details">✕</button>
      </div>
      {q.loading && !d && <Spinner />}
      {q.error && <p className="text-sm text-red-700" role="alert">{q.error}</p>}
      {d && (
        <>
          <dl className="divide-y divide-slate-100">
            <Row k="Agency" v={d.agency_name} />
            <Row k="Route" v={t?.assignments?.length ? t.assignments.map((a) => a.route_code).join(', ') : d.route_code} />
            <Row k="Lat / Lng" v={live?.latitude != null ? `${Number(live.latitude).toFixed(5)}, ${Number(live.longitude).toFixed(5)}` : '—'} />
            <Row k="Speed" v={live?.speed != null ? `${live.speed} km/h` : d.speed != null ? `${d.speed} km/h` : '—'} />
            <Row k="Ignition" v={d.ignition == null ? '—' : d.ignition ? 'On' : 'Off'} />
            <Row k="Last updated" v={<span title={formatDateTime(recordedAt)}>{agoLabel(recordedAt, now)}</span>} />
          </dl>
          <div className="rounded-md bg-slate-50 p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Today ({t.date})</p>
            <dl className="divide-y divide-slate-100">
              <Row k="GPS visit events" v={t.gps_visit_events} />
              <Row k="Assigned PIDs" v={t.assigned_pids} />
              <Row k={VISIT_STATUS.GPS_VISIT_CONFIRMED.label} v={t.covered_pids} />
              <Row k={VISIT_STATUS.GPS_VISIT_CANDIDATE.label} v={t.candidate_pids} />
              <Row k={COVERAGE_LABELS.remaining} v={t.remaining_pids} />
            </dl>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            {assignmentId ? (
              <Link className="font-medium text-emerald-700 hover:underline" to={`/coverage?date=${t.date}&assignment=${assignmentId}`}>Open coverage map</Link>
            ) : (
              <span className="text-slate-400">No assignment today</span>
            )}
            <Link className="font-medium text-emerald-700 hover:underline" to={`/history?vehicle_id=${vehicleId}&date=${todayIST()}`}>View history</Link>
          </div>
          <Disclaimer />
        </>
      )}
    </aside>
  );
}
