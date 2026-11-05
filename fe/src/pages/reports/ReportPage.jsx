// Shared report page (GUIDE #10 D2): URL-synced filters, sortable paginated preview, exports.
import { useState } from 'react';
import { useParams } from 'react-router';
import { reportsApi } from '../../api/resources.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { usePermission } from '../../auth/usePermission.js';
import { MonitoringFilters, usePermittedLookups, useUrlFilters } from '../../components/MonitoringFilters.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { Button } from '../../components/Button.jsx';
import { Disclaimer } from '../../components/Disclaimer.jsx';
import { ErrorState } from '../../components/ErrorState.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Pagination } from '../../components/Pagination.jsx';
import { Spinner } from '../../components/Spinner.jsx';
import NotFoundPage from '../NotFoundPage.jsx';
import { StatusBadge } from '../coverage/CoveragePanels.jsx';
import { formatDateTime } from '../../utils/format.js';
import { downloadBlob } from '../../utils/download.js';
import { todayIST } from '../../utils/dates.js';
import { VISIT_STATUS } from '../../utils/visitStatus.js';
import { REPORT_PAGES, exportErrorMessage, toApiParams } from './reportConfig.js';

const KEYS = ['mode', 'date', 'from', 'to', 'zone_id', 'ward_id', 'agency_id', 'vehicle_id', 'route_id', 'status', 'sort', 'dir', 'page'];

function Cell({ col, row }) {
  const v = row[col.key];
  if (col.key === 'visit_status_label' || col.key === 'missed_reason') return <StatusBadge status={row.visit_status} />;
  if (v === null || v === undefined || v === '') return <span className="text-slate-400">—</span>;
  if (col.type === 'datetime') return formatDateTime(v);
  if (col.type === 'pct') return `${v}%`;
  if (col.type === 'float') return Math.round(v * 10) / 10;
  return String(v);
}

/** Export buttons (reports:export). Disabled while one is in flight; 422/429 explained. */
export function ExportButtons({ onExport, formats = ['xlsx', 'pdf', 'csv'], title }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const run = async (format) => {
    setBusy(format);
    setError(null);
    try {
      const { blob, filename } = await onExport(format);
      downloadBlob(blob, filename);
    } catch (err) {
      setError(exportErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const label = { xlsx: 'Export Excel', pdf: 'Export PDF', csv: 'Export CSV' };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={title || 'Export'}>
        {title && <span className="text-sm font-medium text-slate-700">{title}</span>}
        {formats.map((f) => (
          <Button key={f} size="sm" variant={f === 'xlsx' ? 'primary' : 'secondary'} loading={busy === f} disabled={busy !== null} onClick={() => run(f)}>
            {label[f]}
          </Button>
        ))}
      </div>
      {busy && <p className="text-xs text-slate-500" role="status">Preparing {busy.toUpperCase()}… large reports can take a little while.</p>}
      {error && <p className="max-w-md text-right text-xs text-red-700" role="alert">{error}</p>}
    </div>
  );
}

export function ReportView({ name }) {
  const cfg = REPORT_PAGES[name];
  const can = usePermission();
  const lookups = usePermittedLookups(['zones', 'wards', 'agencies', 'vehicles', 'routes']);
  const [f, setF] = useUrlFilters(KEYS, { mode: 'day', date: todayIST() });
  const params = toApiParams(f);
  const key = `${name}|${JSON.stringify(params)}`;
  const q = useApiQuery((signal) => reportsApi.preview(name, params, { signal }).then((r) => r.data), key);
  const d = q.data;
  const set = (patch) => setF({ ...patch, page: '' });
  const onSort = (k) => setF({ sort: k, dir: (d?.sort === k && d?.dir === 'asc') ? 'desc' : 'asc', page: '' });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{cfg.title}</h1>
          <p className="text-sm text-slate-500">flow {cfg.flow} · times in IST</p>
        </div>
        {can('reports:export') && <ExportButtons onExport={(format) => reportsApi.export(name, params, format)} />}
      </div>

      <MonitoringFilters
        values={f}
        onChange={set}
        fields={cfg.filters}
        lookups={lookups}
        extra={
          <>
            <Select label="Dates" value={f.mode} options={[{ value: 'day', label: 'Single day' }, { value: 'range', label: 'Date range (≤ 31 days)' }]}
              onChange={(e) => set({ mode: e.target.value })} />
            {f.mode === 'range' ? (
              <>
                <Input label="From" type="date" value={f.from} max={todayIST()} onChange={(e) => set({ from: e.target.value })} />
                <Input label="To" type="date" value={f.to} max={todayIST()} onChange={(e) => set({ to: e.target.value })} />
              </>
            ) : (
              <Input label="Date" type="date" value={f.date} max={todayIST()} onChange={(e) => set({ date: e.target.value })} />
            )}
            {cfg.status && (
              <Select label={cfg.status.label} placeholder="All" value={f.status} options={cfg.status.options} onChange={(e) => set({ status: e.target.value })} />
            )}
          </>
        }
      />

      {cfg.chips && d?.reason_counts && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Missed reasons">
          {d.reason_counts.map((c) => {
            const active = f.status === c.reason;
            const meta = VISIT_STATUS[c.reason];
            return (
              <button key={c.reason} type="button" aria-pressed={active} onClick={() => set({ status: active ? '' : c.reason })}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm ring-1 ${active ? 'bg-slate-800 text-white ring-slate-800' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'}`}>
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: meta?.color }} aria-hidden="true" />
                <span aria-hidden="true">{meta?.symbol}</span> {c.label}
                <span className="font-semibold tabular-nums">{c.count}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {q.error ? <ErrorState message={q.error} onRetry={q.reload} /> : !d ? <div className="flex justify-center py-12"><Spinner /></div> : !d.rows.length ? (
          <EmptyState title="No rows" message="Nothing matches these filters." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className={`min-w-full divide-y divide-slate-200 text-sm ${q.loading ? 'opacity-60' : ''}`}>
                <thead className="bg-slate-50">
                  <tr>
                    {d.columns.map((c) => {
                      const sortable = d.sortable.includes(c.key);
                      const active = d.sort === c.key;
                      return (
                        <th key={c.key} scope="col" aria-sort={active ? (d.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                          className="whitespace-nowrap px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                          {sortable ? (
                            <button type="button" onClick={() => onSort(c.key)} className="inline-flex items-center gap-1 hover:text-slate-800">
                              {c.header}{active && <span aria-hidden="true">{d.dir === 'asc' ? '▲' : '▼'}</span>}
                            </button>
                          ) : c.header}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {d.rows.map((r, i) => (
                    <tr key={r.pid_id ? `${r.route_assignment_id}-${r.pid_id}` : i}>
                      {d.columns.map((c) => (
                        <td key={c.key} className={`px-3 py-2 text-slate-700 ${c.key === 'address' || c.key === 'detection_evidence' ? 'min-w-56' : 'whitespace-nowrap'} ${['int', 'pct', 'float'].includes(c.type) ? 'text-right tabular-nums' : ''}`}>
                          <Cell col={c} row={r} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination pagination={d.pagination} onPageChange={(p) => setF({ page: p > 1 ? p : '' })} disabled={q.loading} />
          </>
        )}
      </div>
      <Disclaimer />
    </div>
  );
}

export default function ReportPage() {
  const { name } = useParams();
  if (!REPORT_PAGES[name]) return <NotFoundPage />;
  return <ReportView key={name} name={name} />;
}
