// GUIDE #9 A5 / G7: GPS proximity is never presented as proof of collection.
// Fails if any source file (tests excluded) contains /collect(ed|ion done)/i outside the allowlist.
import { describe, it, expect } from 'vitest';
import { GPS_DISCLAIMER } from '../utils/disclaimer.js';

const sources = import.meta.glob(['../**/*.{js,jsx}', '!../test/**'], { query: '?raw', import: 'default', eager: true });

// Exact phrases that may contain the words (the disclaimer itself NEGATES collection; vehicle naming).
const ALLOWLIST = [GPS_DISCLAIMER, 'garbage collection vehicle'];
const BANNED = /collect(ed|ion done)/i;

export function violations(files) {
  const out = [];
  for (const [path, text] of Object.entries(files)) {
    let t = text;
    for (const ok of ALLOWLIST) t = t.split(ok).join('');
    t.split('\n').forEach((line, i) => {
      if (BANNED.test(line)) out.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

describe('wording rule', () => {
  it('scans the real source tree', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(40);
    expect(Object.keys(sources).some((p) => p.includes('/pages/dashboard/'))).toBe(true);
  });

  it('no "collected" / "collection done" anywhere in src (allowlisted phrases excepted)', () => {
    expect(violations(sources)).toEqual([]);
  });

  it('the check itself catches violations and honours the allowlist', () => {
    expect(violations({ 'a.jsx': '<p>PIDs collected today</p>', 'b.js': "label: 'Collection done'" })).toHaveLength(2);
    expect(violations({ 'c.js': `const t = '${GPS_DISCLAIMER}'; // garbage collection vehicle` })).toEqual([]);
  });
});
