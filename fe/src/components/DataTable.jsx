import { Spinner } from './Spinner.jsx';
import { EmptyState } from './EmptyState.jsx';
import { ErrorState } from './ErrorState.jsx';
import { Pagination } from './Pagination.jsx';

/**
 * columns: [{ key, header, render?: (row) => node, className? }]
 * Handles loading / error / empty states and renders <Pagination> from the API pagination object.
 */
export function DataTable({ columns, rows, loading, error, onRetry, pagination, onPageChange, emptyTitle, emptyMessage, rowKey = 'id' }) {
  let body;
  if (error && !rows?.length) {
    body = <ErrorState message={error} onRetry={onRetry} />;
  } else if (loading && !rows?.length) {
    body = (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  } else if (!rows?.length) {
    body = <EmptyState title={emptyTitle} message={emptyMessage} />;
  } else {
    body = (
      <div className="overflow-x-auto">
        <table className={`min-w-full divide-y divide-slate-200 text-sm ${loading ? 'opacity-60' : ''}`}>
          <thead className="bg-slate-50">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={`whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${c.className || ''}`}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((row) => (
              <tr key={row[rowKey]} className="hover:bg-slate-50">
                {columns.map((c) => (
                  <td key={c.key} className={`whitespace-nowrap px-4 py-2.5 text-slate-700 ${c.className || ''}`}>
                    {c.render ? c.render(row) : (row[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      {body}
      {rows?.length > 0 && <Pagination pagination={pagination} onPageChange={onPageChange} disabled={loading} />}
    </div>
  );
}
