import { Button } from './Button.jsx';

/** Driven by the API's pagination object: { page, limit, total, total_pages }. */
export function Pagination({ pagination, onPageChange, disabled }) {
  if (!pagination) return null;
  const { page, limit, total, total_pages: totalPages } = pagination;
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  return (
    <nav className="flex flex-col items-center justify-between gap-2 px-4 py-3 text-sm text-slate-600 sm:flex-row" aria-label="Pagination">
      <p>
        Showing <span className="font-medium">{from}</span>–<span className="font-medium">{to}</span> of{' '}
        <span className="font-medium">{total}</span>
      </p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </Button>
        <span>
          Page {page} of {totalPages}
        </span>
        <Button variant="secondary" size="sm" disabled={disabled || page >= totalPages} onClick={() => onPageChange(page + 1)}>
          Next
        </Button>
      </div>
    </nav>
  );
}
