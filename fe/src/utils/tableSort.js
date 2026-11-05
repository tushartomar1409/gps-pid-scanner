// Client-side sort / paginate / best-worst for small result sets (vehicle performance table).

/** nulls always last, numbers numerically, strings with locale compare. */
export function sortRows(rows, key, dir = 'asc') {
  const m = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    const xn = x === null || x === undefined;
    const yn = y === null || y === undefined;
    if (xn || yn) return xn === yn ? 0 : xn ? 1 : -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * m;
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * m;
  });
}

export function paginate(rows, page, pageSize) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((p - 1) * pageSize, p * pageSize), page: p, pages, total: rows.length };
}

/** "Worst 10" / "Best 10" by a percentage key; rows with no assigned PIDs (pct null) are excluded. */
export function bestWorst(rows, key, which, n = 10) {
  const valid = rows.filter((r) => r[key] !== null && r[key] !== undefined);
  return sortRows(valid, key, which === 'best' ? 'desc' : 'asc').slice(0, n);
}
