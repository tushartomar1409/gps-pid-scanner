// Consistent status colours across the app.
const STYLES = {
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  INACTIVE: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  MAINTENANCE: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  LOCKED: 'bg-red-50 text-red-700 ring-red-600/20',
};
const LABELS = { ACTIVE: 'Active', INACTIVE: 'Inactive', MAINTENANCE: 'Maintenance', LOCKED: 'Locked' };

export function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STYLES[status] || STYLES.INACTIVE}`}>
      {LABELS[status] || status}
    </span>
  );
}
