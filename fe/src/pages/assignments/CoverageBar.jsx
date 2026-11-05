// Inline coverage breakdown. Colours follow flow.txt §11 (green confirmed, yellow candidate,
// grey unavailable, red remaining).
export const COVERAGE_SEGMENTS = [
  { key: 'confirmed', label: 'Confirmed', color: '#16a34a' },
  { key: 'candidate', label: 'Candidate', color: '#eab308' },
  { key: 'unavailable', label: 'GPS unavailable', color: '#94a3b8' },
  { key: 'remaining', label: 'Remaining', color: '#dc2626' },
];

export function coverageParts(row) {
  const total = row.assigned_pid_count || 0;
  const confirmed = row.covered_pid_count || 0;
  const candidate = row.candidate_pid_count || 0;
  const unavailable = row.unavailable_pid_count || 0;
  return { total, confirmed, candidate, unavailable, remaining: Math.max(0, total - confirmed - candidate - unavailable) };
}

export function CoverageBar({ row }) {
  const p = coverageParts(row);
  const title = COVERAGE_SEGMENTS.map((s) => `${s.label}: ${p[s.key]}`).join(' · ');
  return (
    <div className="flex min-w-[140px] flex-col gap-1" title={title}>
      <div className="flex h-2 overflow-hidden rounded bg-slate-100" aria-hidden="true">
        {p.total > 0 && COVERAGE_SEGMENTS.map((s) => (
          <span key={s.key} style={{ width: `${(p[s.key] / p.total) * 100}%`, background: s.color }} />
        ))}
      </div>
      <span className="text-xs text-slate-600">
        {p.confirmed}/{p.total} confirmed{p.candidate ? ` · ${p.candidate} cand.` : ''}{p.unavailable ? ` · ${p.unavailable} n/a` : ''}
      </span>
    </div>
  );
}
