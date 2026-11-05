// Report Archive (SUPER_ADMIN / DEPARTMENT_ADMIN, GUIDE #10 D5): daily XLSX files from report_runs.
import { useState } from 'react';
import { reportsApi } from '../../api/resources.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { useUrlFilters } from '../../components/MonitoringFilters.jsx';
import { Input } from '../../components/Input.jsx';
import { Select } from '../../components/Select.jsx';
import { Button } from '../../components/Button.jsx';
import { ErrorState } from '../../components/ErrorState.jsx';
import { Pagination } from '../../components/Pagination.jsx';
import { Spinner } from '../../components/Spinner.jsx';
import { formatDateTime } from '../../utils/format.js';
import { downloadBlob } from '../../utils/download.js';
import { REPORT_ORDER, REPORT_PAGES, exportErrorMessage } from './reportConfig.js';

const STATUS_STYLE = { SUCCESS: 'bg-emerald-100 text-emerald-900', FAILED: 'bg-red-100 text-red-900', RUNNING: 'bg-sky-100 text-sky-900' };
const size = (b) => (b == null ? '—' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`);

export default function ReportArchivePage() {
  const [f, setF] = useUrlFilters(['from', 'to', 'type', 'page']);
  const params = { ...f, page: Number(f.page) || 1, limit: 25 };
  const key = JSON.stringify(params);
  const q = useApiQuery((signal) => reportsApi.archive(JSON.parse(key), { signal }), key);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const set = (patch) => setF({ ...patch, page: '' });

  const download = async (id) => {
    setBusy(id);
    setError(null);
    try {
      const { blob, filename } = await reportsApi.archiveDownload(id);
      downloadBlob(blob, filename);
    } catch (err) {
      setError(exportErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Report Archive</h1>
        <p className="text-sm text-slate-500">Automatic daily Excel reports for the previous operational day (all zones).</p>
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:grid-cols-4" role="search" aria-label="Filters">
        <Input label="From" type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />
        <Input label="To" type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />
        <Select label="Report" placeholder="All reports" value={f.type} options={REPORT_ORDER.map((k) => ({ value: k, label: REPORT_PAGES[k].title }))} onChange={(e) => set({ type: e.target.value })} />
      </div>
      {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {q.error ? <ErrorState message={q.error} onRetry={q.reload} /> : !q.data ? <div className="flex justify-center py-10"><Spinner /></div> : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>{['Date', 'Report', 'Status', 'Rows', 'Size', 'Generated', ''].map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap px-3 py-2">{r.operational_date}</td>
                      <td className="px-3 py-2">{REPORT_PAGES[r.report_type]?.title ?? r.report_type} <span className="text-xs uppercase text-slate-400">{r.format}</span></td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status] || ''}`} title={r.error || undefined}>{r.status}</span>
                        {r.status === 'SUCCESS' && !r.finalized && (
                          <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900" title="Generated before every assignment of the day was finalized">not finalized</span>
                        )}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{r.row_count ?? '—'}</td>
                      <td className="px-3 py-2 tabular-nums">{size(r.size_bytes)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{formatDateTime(r.finished_at || r.created_at)}</td>
                      <td className="px-3 py-2">
                        {r.status === 'SUCCESS' && (
                          <Button size="sm" variant="secondary" loading={busy === r.id} disabled={busy !== null} onClick={() => download(r.id)}>Download</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!q.data.data.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">No archived reports yet. They are generated daily after {`06:00`} IST.</td></tr>}
                </tbody>
              </table>
            </div>
            <Pagination pagination={q.data.pagination} onPageChange={(p) => setF({ page: p > 1 ? p : '' })} />
          </>
        )}
      </div>
    </div>
  );
}
