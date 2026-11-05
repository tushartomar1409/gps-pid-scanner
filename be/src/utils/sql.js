// Tiny helper for building parameterized WHERE clauses. Values are never interpolated.
export class SqlWhere {
  constructor() {
    this.clauses = [];
    this.params = [];
  }

  /** Register a value and return its placeholder ($n). */
  param(value) {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  /** add('t.col = ?', v) — each `?` becomes the next numbered placeholder. */
  add(fragment, ...values) {
    let i = 0;
    this.clauses.push(fragment.replace(/\?/g, () => this.param(values[i++])));
    return this;
  }

  /** Equality filter, skipped when value is empty. */
  eq(column, value) {
    if (value !== undefined && value !== null && value !== '') this.add(`${column} = ?`, value);
    return this;
  }

  /** Case-insensitive contains across several columns (OR). */
  search(columns, term) {
    if (!term || !columns?.length) return this;
    const p = this.param(`%${escapeLike(term)}%`);
    this.clauses.push(`(${columns.map((c) => `${c}::text ILIKE ${p}`).join(' OR ')})`);
    return this;
  }

  toSql() {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }
}

export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function paginationMeta(page, limit, total) {
  return { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) };
}
