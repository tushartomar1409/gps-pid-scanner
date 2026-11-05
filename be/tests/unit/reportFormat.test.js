// GUIDE #10: evidence summary, CSV safety, filenames, IST formatting, PDF script runs + Devanagari shaping.
import { describe, it, expect } from 'vitest';
import * as fontkit from 'fontkit';
import { evidenceSummary, visitStatusLabel, VISIT_STATUS_LABELS } from '../../src/services/reports/labels.js';
import { csvCell, csvField, exportFilename, guardFormula, istDateTime, scopeLabel, displayValue } from '../../src/services/reports/format.js';
import { FONT_FILES, scriptRuns } from '../../src/services/reports/pdfWriter.js';

describe('evidenceSummary (one format, GUIDE #10 A1)', () => {
  it('formats points, segments, ambiguity and rejections', () => {
    expect(evidenceSummary({ points: 2, closest_m: 12.4, segments: 1, ambiguous: true })).toBe('2 GPS points (closest 12 m) · 1 track segment · ambiguous');
    expect(evidenceSummary({ points: 1, closest_m: 7.6 })).toBe('1 GPS point (closest 8 m)');
    expect(evidenceSummary({ segments: 3 })).toBe('3 track segments');
    expect(evidenceSummary({ rejected_speed: 2, rejected_stale: 1 })).toBe('2 rejected (speed) · 1 rejected (stale)');
    expect(evidenceSummary({ ambiguous: true })).toBe('No GPS evidence'); // ambiguity without evidence is meaningless
    expect(evidenceSummary({})).toBe('No GPS evidence');
  });

  it('status labels match the frontend map and never say "collected"', () => {
    expect(VISIT_STATUS_LABELS).toEqual({
      GPS_VISIT_CONFIRMED: 'GPS Visit Confirmed', GPS_VISIT_CANDIDATE: 'GPS Visit Candidate', NOT_VISITED: 'Not Visited', GPS_DATA_UNAVAILABLE: 'GPS Data Unavailable',
    });
    expect(visitStatusLabel('X')).toBe('X');
    expect(JSON.stringify(VISIT_STATUS_LABELS)).not.toMatch(/collect/i);
  });
});

describe('CSV safety', () => {
  it('RFC 4180 quoting', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('formula-injection guard on text cells only; numbers stay raw', () => {
    for (const bad of ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\tx', '\rx']) expect(guardFormula(bad).startsWith("'")).toBe(true);
    expect(csvCell('text', '=HYPERLINK("http://evil","click")')).toBe('"\'=HYPERLINK(""http://evil"",""click"")"');
    expect(csvCell('coord', -12.5)).toBe('-12.5');
    expect(csvCell('text', 'House 7')).toBe('House 7');
    expect(csvCell('text', null)).toBe('');
  });
});

describe('formatting helpers', () => {
  it('IST date-times, display values, filenames, scope labels', () => {
    expect(istDateTime('2031-03-10T03:35:00Z')).toBe('2031-03-10 09:05');
    expect(istDateTime(null)).toBe('');
    expect(displayValue('pct', 28.571)).toBe('28.6%');
    expect(exportFilename('daily-coverage', { from: '2031-03-10', to: '2031-03-10' }, 'ward-5', 'xlsx')).toBe('daily-coverage_2031-03-10_ward-5.xlsx');
    expect(exportFilename('ward-wise', { from: '2031-03-01', to: '2031-03-10' }, 'all', 'csv')).toBe('ward-wise_2031-03-01_to_2031-03-10_all.csv');
    expect(exportFilename('x"; rm -rf /', { from: 'a/../b', to: 'a/../b' }, 'all', 'pdf')).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(scopeLabel({ unrestricted: true })).toBe('all');
    expect(scopeLabel({ unrestricted: false, role_key: 'AGENCY_USER', agency_id: 4 })).toBe('agency-4');
  });
});

describe('PDF fonts: Noto Sans + Noto Sans Devanagari', () => {
  it('splits mixed text into per-script runs (spaces stay in the current run)', () => {
    expect(scriptRuns('House 12, सेक्टर 7')).toEqual([
      { font: 'latin', text: 'House 12, ' }, { font: 'deva', text: 'सेक्टर ' }, { font: 'latin', text: '7' },
    ]);
    expect(scriptRuns('Ünï ₹').map((r) => r.font)).toEqual(['latin', 'latinExt']); // ₹ is not in the Latin subset
  });

  it('fontkit applies Devanagari shaping: conjuncts, i-matra reordering, reph', () => {
    const f = fontkit.openSync(FONT_FILES.deva);
    const names = (s) => f.layout(s).glyphs.map((g) => g.name);
    expect(names('क्ष')).toEqual(['uni0915094D0937']); // 3 code points -> 1 conjunct glyph
    expect(names('कि')).toEqual(['uni093F.04', 'uni0915']); // ि drawn BEFORE क
    expect(names('र्क')).toEqual(['uni0915', 'uni0930094D']); // reph moved after the base consonant
  });
});
