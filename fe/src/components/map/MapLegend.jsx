/** Reusable legend: items = [{ key, color, label }]. Used now for coord status, later for visit status. */
export function MapLegend({ items, title = 'Legend', className = '' }) {
  return (
    <div className={`rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-xs shadow-sm ${className}`} aria-label={title}>
      <p className="mb-1 font-semibold text-slate-700">{title}</p>
      <ul className="flex flex-col gap-1">
        {items.map((i) => (
          <li key={i.key || i.label} className="flex items-center gap-2 text-slate-600">
            <span className="inline-block h-3 w-3 rounded-full border border-white shadow" style={{ background: i.color }} aria-hidden="true" />
            {i.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
