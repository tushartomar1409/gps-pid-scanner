export function Skeleton({ className = 'h-4 w-full' }) {
  return <div className={`animate-pulse rounded bg-slate-200 ${className}`} aria-hidden="true" />;
}

/** Suspense fallback for lazy pages. */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading page">
      <Skeleton className="h-7 w-56" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

/** Card wrapper used by dashboard charts: loading / error / empty / content. */
export function ChartCard({ title, subtitle, loading, error, onRetry, empty, emptyText = 'No data for this selection', actions, children, className = '' }) {
  let body;
  if (error) {
    body = (
      <div className="flex h-56 flex-col items-center justify-center gap-2 text-center" role="alert">
        <p className="text-sm text-red-700">{error}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50">
            Try again
          </button>
        )}
      </div>
    );
  } else if (loading) body = <Skeleton className="h-56 w-full" />;
  else if (empty) body = <div className="flex h-56 items-center justify-center text-sm text-slate-500">{emptyText}</div>;
  else body = children;
  return (
    <section className={`rounded-lg border border-slate-200 bg-white p-4 shadow-sm ${className}`} aria-label={title}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {body}
    </section>
  );
}
