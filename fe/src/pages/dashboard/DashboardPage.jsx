// Monitoring dashboard (GUIDE #9 B, flow §13). All numbers come from /api/dashboard/* — nothing is
// recomputed on the client. Live: pid:status -> 5 s debounce -> refetch summary + the charts in view;
// socket resync -> refetch everything.
import { useEffect, useMemo, useState } from 'react';
import { dashboardApi } from '../../api/resources.js';
import { useApiQuery, useDebouncedCallback } from '../../hooks/useApiQuery.js';
import { useInView } from '../../hooks/useInView.js';
import { useResync, useSocketEvent } from '../../realtime/hooks.js';
import { MonitoringFilters, usePermittedLookups, useUrlFilters } from '../../components/MonitoringFilters.jsx';
import { ChartCard } from '../../components/Skeleton.jsx';
import { Disclaimer } from '../../components/Disclaimer.jsx';
import { ErrorState } from '../../components/ErrorState.jsx';
import { addDaysISO, todayIST } from '../../utils/dates.js';
import { SummaryCards } from './SummaryCards.jsx';
import { VehiclePerformanceTable } from './VehiclePerformanceTable.jsx';
import { AgencyBars, CoverageStackedBars, HourlyChart, TrendLines } from './DashboardCharts.jsx';

export const LIVE_DEBOUNCE_MS = 5000;
const FILTER_KEYS = ['date', 'zone_id', 'ward_id', 'agency_id', 'vehicle_id'];

/** One chart section: fetches its own data, refetches on `tick` only while visible, always on `resync`. */
function Section({ title, subtitle, fetcher, params, tick, resync, isEmpty, render, className }) {
  const [ref, inView] = useInView();
  const key = JSON.stringify(params);
  const q = useApiQuery((signal) => fetcher(JSON.parse(key), { signal }).then((r) => r.data), key);
  const { reload } = q;
  useEffect(() => {
    if (tick && inView) reload();
  }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps -- only on a new live tick
  useEffect(() => {
    if (resync) reload();
  }, [resync]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} className={className}>
      <ChartCard title={title} subtitle={subtitle} loading={q.loading && !q.data} error={q.error} onRetry={reload} empty={q.data && isEmpty(q.data)}>
        {q.data && render(q.data)}
      </ChartCard>
    </div>
  );
}

export default function DashboardPage({ debounceMs = LIVE_DEBOUNCE_MS }) {
  const [filters, setFilters] = useUrlFilters(FILTER_KEYS, { date: todayIST() });
  const lookups = usePermittedLookups(['zones', 'wards', 'agencies', 'vehicles']);
  const [tick, setTick] = useState(0);
  const [resync, setResync] = useState(0);

  const params = useMemo(() => ({ ...filters, date: filters.date || todayIST() }), [filters]);
  const trendParams = useMemo(() => {
    const { date, ...rest } = params;
    return { ...rest, from: addDaysISO(date, -13), to: date };
  }, [params]);
  const key = JSON.stringify(params);

  const summary = useApiQuery((signal) => dashboardApi.summary(JSON.parse(key), { signal }).then((r) => r.data), key);
  const reloadSummary = summary.reload;

  const onLive = useDebouncedCallback(() => {
    reloadSummary();
    setTick((t) => t + 1);
  }, debounceMs);
  useSocketEvent('pid:status', onLive);
  useResync(() => {
    reloadSummary();
    setResync((t) => t + 1);
  });

  const empty = (d) => !d.groups?.length;
  const live = { tick, resync };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-500">GPS-based visit monitoring · times in IST</p>
        </div>
      </div>
      <MonitoringFilters values={params} onChange={setFilters} fields={FILTER_KEYS} lookups={lookups} />

      {summary.error && !summary.data ? (
        <ErrorState message={summary.error} onRetry={reloadSummary} />
      ) : (
        <SummaryCards data={summary.data} loading={summary.loading} />
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Section title="Zone-wise coverage" subtitle="PIDs by GPS status; label = GPS confirmed %" fetcher={(p, o) => dashboardApi.grouped('zone-coverage', p, o)}
          params={params} {...live} isEmpty={empty} render={(d) => <CoverageStackedBars groups={d.groups} />} />
        <Section title="Ward-wise coverage" subtitle="PIDs by GPS status; label = GPS confirmed %" fetcher={(p, o) => dashboardApi.grouped('ward-coverage', p, o)}
          params={params} {...live} isEmpty={empty} render={(d) => <CoverageStackedBars groups={d.groups} />} />
        <Section title="Agency performance" fetcher={(p, o) => dashboardApi.grouped('agency-performance', p, o)} params={params} {...live} isEmpty={empty}
          render={(d) => (
            <>
              <AgencyBars groups={d.groups} />
              <table className="mt-3 min-w-full text-sm">
                <thead className="text-xs uppercase text-slate-500">
                  <tr><th className="py-1 text-left">Agency</th><th className="text-right">Assigned</th><th className="text-right">Confirmed</th><th className="text-right">Candidate</th><th className="text-right">Confirmed %</th><th className="text-right">Detected %</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {d.groups.map((g) => (
                    <tr key={g.group_id ?? 'none'}>
                      <td className="py-1">{g.group_name}</td><td className="text-right">{g.assigned}</td><td className="text-right">{g.confirmed}</td>
                      <td className="text-right">{g.candidate}</td><td className="text-right">{g.confirmed_pct ?? '—'}%</td><td className="text-right">{g.detected_pct ?? '—'}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )} />
        <Section title="Daily trend (last 14 days)" subtitle="GPS confirmed % and GPS visit detected %" fetcher={dashboardApi.dailyTrend} params={trendParams} {...live}
          isEmpty={(d) => !d.days?.some((x) => x.assigned > 0)} render={(d) => <TrendLines days={d.days} />} />
        <Section title="Vehicle performance" fetcher={(p, o) => dashboardApi.grouped('vehicle-performance', p, o)} params={params} {...live} isEmpty={empty}
          className="xl:col-span-2" render={(d) => <VehiclePerformanceTable groups={d.groups} />} />
        <Section title="Hourly activity" subtitle="GPS points and GPS visit events per IST hour" fetcher={dashboardApi.hourly} params={params} {...live}
          isEmpty={(d) => !d.hours?.some((h) => h.gps_points || h.visit_events)} className="xl:col-span-2" render={(d) => <HourlyChart hours={d.hours} />} />
      </div>
      <Disclaimer />
    </div>
  );
}
