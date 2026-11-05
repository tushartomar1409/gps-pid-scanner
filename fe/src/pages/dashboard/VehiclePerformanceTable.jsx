import { useMemo, useState } from 'react';
import { bestWorst, paginate, sortRows } from '../../utils/tableSort.js';
import { formatDateTime } from '../../utils/format.js';
import { COVERAGE_LABELS } from '../../utils/disclaimer.js';

const COLS = [
  { key: 'group_name', header: 'Vehicle' },
  { key: 'agency_name', header: 'Agency' },
  { key: 'assigned', header: 'Assigned', num: true },
  { key: 'confirmed_pct', header: 'Confirmed %', num: true, pct: true },
  { key: 'detected_pct', header: 'Detected %', num: true, pct: true },
  { key: 'first_gps_activity', header: 'First GPS', time: true },
  { key: 'last_gps_activity', header: 'Last GPS', time: true },
];
const PAGE = 15;

export function VehiclePerformanceTable({ groups }) {
  const [sort, setSort] = useState({ key: 'confirmed_pct', dir: 'asc' });
  const [quick, setQuick] = useState('all'); // all | worst | best
  const [page, setPage] = useState(1);

  const view = useMemo(() => {
    if (quick === 'worst' || quick === 'best') return paginate(bestWorst(groups, 'confirmed_pct', quick), 1, 10);
    return paginate(sortRows(groups, sort.key, sort.dir), page, PAGE);
  }, [groups, sort, quick, page]);

  const onSort = (key) => {
    setQuick('all');
    setPage(1);
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick filter">
        {[['all', 'All vehicles'], ['worst', 'Worst 10'], ['best', 'Best 10']].map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => { setQuick(k); setPage(1); }}
            aria-pressed={quick === k}
            className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${quick === k ? 'bg-emerald-700 text-white ring-emerald-700' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'}`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto self-center text-xs text-slate-500">by {COVERAGE_LABELS.confirmedPct}</span>
      </div>
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {COLS.map((c) => (
                <th key={c.key} scope="col" aria-sort={quick === 'all' && sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={`whitespace-nowrap px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 ${c.num ? 'text-right' : 'text-left'}`}>
                  <button type="button" onClick={() => onSort(c.key)} className="inline-flex items-center gap-1 hover:text-slate-800">
                    {c.header}
                    {quick === 'all' && sort.key === c.key && <span aria-hidden="true">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {view.rows.map((r) => (
              <tr key={r.group_id}>
                {COLS.map((c) => (
                  <td key={c.key} className={`whitespace-nowrap px-3 py-2 text-slate-700 ${c.num ? 'text-right tabular-nums' : ''}`}>
                    {c.time ? formatDateTime(r[c.key]) : c.pct ? (r[c.key] === null ? '—' : `${r[c.key]}%`) : (r[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {quick === 'all' && view.pages > 1 && (
        <div className="flex items-center justify-between text-xs text-slate-600">
          <span>{view.total} vehicles · page {view.page} of {view.pages}</span>
          <span className="flex gap-1">
            <button type="button" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)} className="rounded px-2 py-1 ring-1 ring-slate-300 disabled:opacity-40">Previous</button>
            <button type="button" disabled={view.page >= view.pages} onClick={() => setPage(view.page + 1)} className="rounded px-2 py-1 ring-1 ring-slate-300 disabled:opacity-40">Next</button>
          </span>
        </div>
      )}
    </div>
  );
}
