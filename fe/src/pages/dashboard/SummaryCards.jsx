import { Skeleton } from '../../components/Skeleton.jsx';
import { Disclaimer } from '../../components/Disclaimer.jsx';
import { COVERAGE_LABELS } from '../../utils/disclaimer.js';
import { VISIT_STATUS } from '../../utils/visitStatus.js';

const fmtPct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
const fmtN = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-IN'));

function Card({ label, value, hint, accent }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <p className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
        {accent && <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: accent }} aria-hidden="true" />}
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function SummaryCards({ data, loading }) {
  if (loading && !data) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[76px]" />)}
      </div>
    );
  }
  if (!data) return null;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <section className="rounded-lg border border-emerald-200 bg-emerald-50 px-5 py-4 shadow-sm lg:col-span-1" aria-label={COVERAGE_LABELS.confirmedPct}>
          <p className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
            {COVERAGE_LABELS.confirmedPct} <Disclaimer variant="icon" />
          </p>
          <p className="mt-1 text-5xl font-bold tabular-nums text-emerald-800" data-testid="headline-pct">{fmtPct(data.gps_confirmed_coverage_pct)}</p>
          <p className="mt-1 text-xs text-emerald-900/80">
            {fmtN(data.gps_confirmed_pids)} of {fmtN(data.assigned_pids)} assigned PIDs GPS confirmed
          </p>
        </section>
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:col-span-2 lg:grid-cols-5" aria-label="Visit status counts">
          <Card label={COVERAGE_LABELS.detectedPct} value={fmtPct(data.gps_visit_detected_pct)} hint="confirmed + candidate" />
          <Card label={VISIT_STATUS.GPS_VISIT_CONFIRMED.label} value={fmtN(data.gps_confirmed_pids)} accent={VISIT_STATUS.GPS_VISIT_CONFIRMED.color} />
          <Card label={VISIT_STATUS.GPS_VISIT_CANDIDATE.label} value={fmtN(data.gps_candidate_pids)} accent={VISIT_STATUS.GPS_VISIT_CANDIDATE.color} />
          <Card label={COVERAGE_LABELS.remaining} value={fmtN(data.remaining_pids)} />
          <Card label={COVERAGE_LABELS.remainingUndetected} value={fmtN(data.remaining_undetected_pids)} accent={VISIT_STATUS.NOT_VISITED.color} />
        </section>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" aria-label="Vehicles and PIDs">
        <Card label="Total vehicles" value={fmtN(data.total_vehicles)} hint="registered, status Active" />
        <Card label={COVERAGE_LABELS.activeVehicles} value={fmtN(data.active_vehicles)} />
        <Card label={COVERAGE_LABELS.onlineNow} value={fmtN(data.online_now)} />
        <Card label="Offline vehicles" value={fmtN(data.offline_vehicles)} hint="no GPS on date" />
        <Card label="Total registered PIDs" value={fmtN(data.total_registered_pids)} />
        <Card label="Assigned PIDs" value={fmtN(data.assigned_pids)} />
      </div>
    </div>
  );
}
