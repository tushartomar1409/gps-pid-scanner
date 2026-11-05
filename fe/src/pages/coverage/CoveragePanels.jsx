import { visitsApi } from '../../api/resources.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { Spinner } from '../../components/Spinner.jsx';
import { Disclaimer } from '../../components/Disclaimer.jsx';
import { COVERAGE_LABELS } from '../../utils/disclaimer.js';
import { coverageLegendItems, evidenceLabel, isRejectedEvidence, visitStatusMeta } from '../../utils/visitStatus.js';
import { formatDateTime } from '../../utils/format.js';

export function StatusBadge({ status }) {
  const m = visitStatusMeta(status);
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset"
      style={{ background: `${m.color}22`, color: '#1e293b', boxShadow: `inset 0 0 0 1px ${m.color}` }}>
      <span aria-hidden="true">{m.symbol}</span>
      {m.label}
    </span>
  );
}

/** Legend with every flow §11 colour + the disclaimer. */
export function CoverageLegend() {
  return (
    <div className="rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-xs shadow-sm" aria-label="Coverage legend">
      <p className="mb-1 font-semibold text-slate-700">Legend</p>
      <ul className="flex flex-col gap-1">
        {coverageLegendItems().map((i) => (
          <li key={i.key} className="flex items-center gap-2 text-slate-600">
            {i.line ? (
              <svg width="18" height="6" aria-hidden="true"><line x1="0" y1="3" x2="18" y2="3" stroke={i.color} strokeWidth="3" strokeDasharray={i.dashed ? '4 3' : undefined} /></svg>
            ) : (
              <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: i.color }} aria-hidden="true">{i.symbol || ''}</span>
            )}
            {i.label}
          </li>
        ))}
      </ul>
      <Disclaimer className="mt-2 max-w-[16rem]" />
    </div>
  );
}

/** PID drawer content: details + evidence list (flow §11). */
export function PidDetails({ pid, assignment, canViewEvidence }) {
  const enabled = Boolean(canViewEvidence && pid && assignment);
  const q = useApiQuery(
    (signal) => visitsApi.events({ date: assignment.operational_date, pid_id: pid.pid_id, route_assignment_id: assignment.route_assignment_id, limit: 100 }, { signal }).then((r) => r.data),
    `${pid?.pid_id}-${assignment?.route_assignment_id}-${pid?.visit_status}`,
    { enabled },
  );
  const rows = [
    ['PID number', pid.pid_number], ['Address', pid.address], ['Ward', pid.ward_name], ['Zone', pid.zone_name],
    ['Route', assignment.route?.route_code], ['Vehicle', assignment.vehicle?.vehicle_number],
    ['First GPS visit', formatDateTime(pid.first_visit_at)], ['Last GPS visit', formatDateTime(pid.last_visit_at)],
    ['Minimum distance', pid.min_distance_meters != null ? `${pid.min_distance_meters} m` : '—'],
  ];
  return (
    <div className="flex flex-col gap-4">
      <div><StatusBadge status={pid.visit_status} /></div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <dt className="text-xs text-slate-500">{k}</dt>
            <dd className="text-slate-800">{v || '—'}</dd>
          </div>
        ))}
      </dl>
      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-800">GPS evidence</h3>
        {!canViewEvidence && <p className="text-sm text-slate-500">You do not have permission to view visit evidence.</p>}
        {q.loading && <Spinner />}
        {q.error && <p className="text-sm text-red-700" role="alert">{q.error}</p>}
        {q.data && !q.data.length && <p className="text-sm text-slate-500">No GPS evidence for this PID on this assignment.</p>}
        {q.data?.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200" aria-label="Evidence list">
            {q.data.map((e) => (
              <li key={e.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 text-sm ${isRejectedEvidence(e.evidence_status) ? 'text-slate-500' : 'text-slate-800'}`}>
                <span className="tabular-nums text-slate-600">{formatDateTime(e.detected_at)}</span>
                <span className="font-medium">{evidenceLabel(e)}</span>
                <span className="tabular-nums text-slate-500">{e.distance_meters != null ? `${Number(e.distance_meters)} m` : ''}</span>
                {e.ambiguous && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900" title={`${e.pids_in_radius} PIDs within radius of this GPS point`}>
                    Ambiguous ({e.pids_in_radius} PIDs)
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <Disclaimer />
    </div>
  );
}

const Stat = ({ k, v, hint }) => (
  <div className="rounded-md bg-slate-50 px-3 py-2">
    <p className="text-xs text-slate-500">{k}</p>
    <p className="text-lg font-semibold tabular-nums text-slate-900">{v ?? '—'}</p>
    {hint && <p className="text-xs text-slate-500">{hint}</p>}
  </div>
);

export function ComparisonPanel({ data, counts, activeSegment, onSegment }) {
  if (!data) return null;
  const c = counts || data.counts;
  const q = data.distance_quality;
  const dev = data.route_deviation;
  const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m} m`);
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Route comparison">
      <h2 className="text-sm font-semibold text-slate-800">Assigned vs actual route</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat k={COVERAGE_LABELS.confirmedPct} v={c.confirmed_pct === null ? '—' : `${c.confirmed_pct}%`} />
        <Stat k={COVERAGE_LABELS.detectedPct} v={c.detected_pct === null ? '—' : `${c.detected_pct}%`} />
        <Stat k="Assigned PIDs" v={c.assigned} />
        <Stat k="GPS confirmed" v={c.confirmed} />
        <Stat k="GPS candidate" v={c.candidate} />
        <Stat k={COVERAGE_LABELS.remaining} v={c.remaining} />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-slate-500">GPS route distance</span>
          <span className="font-semibold tabular-nums">{km(data.gps_route_distance_m)}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${q.reliable ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}>
            {q.reliable ? '✓ Reliable' : '⚠ Not reliable'}
          </span>
        </p>
        {!q.reliable && <ul className="list-disc pl-5 text-xs text-amber-900">{q.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        <p className="text-xs text-slate-500">
          {q.points} GPS points · {q.jitter_segments_skipped} stationary-jitter and {q.outlier_segments_skipped} outlier segments excluded
        </p>
        <p className="text-xs text-slate-500">
          First GPS activity {formatDateTime(data.first_gps_activity)} · last {formatDateTime(data.last_gps_activity)}
        </p>
      </div>
      <div className="text-sm">
        <h3 className="mb-1 font-semibold text-slate-800">Route deviation</h3>
        {!dev ? (
          <p className="text-xs text-slate-500">This route has no assigned geometry, so deviation cannot be measured.</p>
        ) : (
          <>
            <p className="text-xs text-slate-600">
              {dev.pct_off_route}% of points more than {dev.threshold_m} m off route · max {dev.max_deviation_m} m · {dev.off_route_segment_count} segment(s)
            </p>
            {dev.off_route_segments.length > 0 && (
              <ul className="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto" aria-label="Off-route segments">
                {dev.off_route_segments.map((s, i) => (
                  <li key={`${s.from}-${i}`}>
                    <button type="button" onClick={() => onSegment(i)} aria-pressed={activeSegment === i}
                      className={`w-full rounded px-2 py-1 text-left text-xs ring-1 ${activeSegment === i ? 'bg-red-50 ring-red-300' : 'ring-slate-200 hover:bg-slate-50'}`}>
                      {formatDateTime(s.from)} → {formatDateTime(s.to)} · max {s.max_m} m · {s.points} pts
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {data.actual_track.downsampled && (
        <p className="text-xs text-slate-500">Trail downsampled: showing {data.actual_track.points.length} of {data.actual_track.total_in_window} points.</p>
      )}
    </section>
  );
}
