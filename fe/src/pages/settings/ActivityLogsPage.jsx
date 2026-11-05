// Activity Logs (SUPER_ADMIN, GUIDE #9 F3). `details` is already redacted by the server.
import { Fragment, useState } from 'react';
import { activityLogsApi } from '../../api/resources.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { useUrlFilters } from '../../components/MonitoringFilters.jsx';
import { Input } from '../../components/Input.jsx';
import { ErrorState } from '../../components/ErrorState.jsx';
import { Pagination } from '../../components/Pagination.jsx';
import { Spinner } from '../../components/Spinner.jsx';
import { formatDateTime } from '../../utils/format.js';

const KEYS = ['page', 'user_id', 'module', 'action', 'reference_id', 'from', 'to'];
/** date input (YYYY-MM-DD, IST) -> ISO with offset; `to` is end of that day. */
const dayIso = (d, end) => (d ? `${d}T${end ? '23:59:59' : '00:00:00'}+05:30` : undefined);

export default function ActivityLogsPage() {
  const [f, setF] = useUrlFilters(KEYS);
  const [open, setOpen] = useState(null);
  const params = { ...f, page: Number(f.page) || 1, limit: 25, from: dayIso(f.from), to: dayIso(f.to, true) };
  const key = JSON.stringify(params);
  const q = useApiQuery((signal) => activityLogsApi.list(JSON.parse(key), { signal }), key);
  const set = (patch) => setF({ ...patch, page: '' });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-slate-900">Activity Logs</h1>
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:grid-cols-3 lg:grid-cols-6" role="search" aria-label="Filters">
        <Input label="User id" inputMode="numeric" value={f.user_id} onChange={(e) => set({ user_id: e.target.value.replace(/\D/g, '') })} />
        <Input label="Module" value={f.module} onChange={(e) => set({ module: e.target.value })} placeholder="e.g. users" />
        <Input label="Action" value={f.action} onChange={(e) => set({ action: e.target.value })} placeholder="e.g. UPDATE" />
        <Input label="Reference id" value={f.reference_id} onChange={(e) => set({ reference_id: e.target.value })} />
        <Input label="From" type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />
        <Input label="To" type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />
      </div>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {q.error ? <ErrorState message={q.error} onRetry={q.reload} /> : !q.data ? <div className="flex justify-center py-10"><Spinner /></div> : (
          <>
            <div className="overflow-x-auto">
              <table className={`min-w-full divide-y divide-slate-200 text-sm ${q.loading ? 'opacity-60' : ''}`}>
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>{['Time', 'User', 'Action', 'Module', 'Reference', 'IP', ''].map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((r) => (
                    <Fragment key={r.id}>
                      <tr>
                        <td className="whitespace-nowrap px-3 py-1.5">{formatDateTime(r.created_at)}</td>
                        <td className="px-3 py-1.5">{r.user_name ? `${r.user_name} (#${r.user_id})` : r.user_id ? `#${r.user_id}` : 'system'}</td>
                        <td className="px-3 py-1.5">{r.action}</td>
                        <td className="px-3 py-1.5">{r.module}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">{r.reference_id ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">{r.ip_address ?? '—'}</td>
                        <td className="px-3 py-1.5">
                          {r.details && (
                            <button type="button" className="text-xs font-medium text-emerald-700 hover:underline" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                              {open === r.id ? 'Hide' : 'Details'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {open === r.id && (
                        <tr><td colSpan={7} className="bg-slate-50 px-3 py-2"><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-slate-700">{JSON.stringify(r.details, null, 2)}</pre></td></tr>
                      )}
                    </Fragment>
                  ))}
                  {!q.data.data.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">No activity matches these filters</td></tr>}
                </tbody>
              </table>
            </div>
            <Pagination pagination={q.data.pagination} onPageChange={(p) => setF({ page: p > 1 ? p : '' })} disabled={q.loading} />
          </>
        )}
      </div>
    </div>
  );
}
