// PDF writer (GUIDE #10 B4): pdfkit, A4 landscape, header per page, footer "Page x / y" + disclaimer,
// repeating table header, wrapped cells.
// Fonts: Noto Sans (Latin, Latin-Ext) + Noto Sans Devanagari, embedded. The @fontsource files are script
// SUBSETS, so text is split into per-script runs and each run is drawn with the font that has its glyphs.
// fontkit (pdfkit's layout engine) applies the Devanagari OpenType shaping (conjuncts, matra reordering,
// reph) — verified in tests/unit/pdfFonts.test.js.
// Pages are buffered (bufferPages) to write the "x / y" footer; memory is bounded by the 5,000-row PDF cap.
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import * as fontkit from 'fontkit';
import { displayValue } from './format.js';

const require = createRequire(import.meta.url);
const file = (pkg, name) => require.resolve(`${pkg}/files/${name}`);
export const FONT_FILES = {
  latin: file('@fontsource/noto-sans', 'noto-sans-latin-400-normal.woff'),
  latinBold: file('@fontsource/noto-sans', 'noto-sans-latin-700-normal.woff'),
  latinExt: file('@fontsource/noto-sans', 'noto-sans-latin-ext-400-normal.woff'),
  latinExtBold: file('@fontsource/noto-sans', 'noto-sans-latin-ext-700-normal.woff'),
  deva: file('@fontsource/noto-sans-devanagari', 'noto-sans-devanagari-devanagari-400-normal.woff'),
  devaBold: file('@fontsource/noto-sans-devanagari', 'noto-sans-devanagari-devanagari-700-normal.woff'),
};

let coverage = null;
function fonts() {
  if (!coverage) coverage = Object.fromEntries(['latin', 'latinExt', 'deva'].map((k) => [k, fontkit.openSync(FONT_FILES[k])]));
  return coverage;
}
const isDeva = (cp) => (cp >= 0x0900 && cp <= 0x097f) || (cp >= 0xa8e0 && cp <= 0xa8ff) || (cp >= 0x1cd0 && cp <= 0x1cff) || cp === 0x200c || cp === 0x200d;

/** Split text into [{ font: 'latin'|'latinExt'|'deva', text }] runs. Spaces stay in the current run. */
export function scriptRuns(text) {
  const f = fonts();
  const runs = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    let font;
    if (isDeva(cp)) font = 'deva';
    else if (cp === 0x20 && runs.length) font = runs[runs.length - 1].font;
    else if (f.latin.hasGlyphForCodePoint(cp)) font = 'latin';
    else if (f.latinExt.hasGlyphForCodePoint(cp)) font = 'latinExt';
    else if (f.deva.hasGlyphForCodePoint(cp)) font = 'deva';
    else font = 'latin'; // renders the .notdef box; never silently drops a character
    const last = runs[runs.length - 1];
    if (last && last.font === font) last.text += ch;
    else runs.push({ font, text: ch });
  }
  return runs;
}

const graphemes = (s) => [...new Intl.Segmenter('hi', { granularity: 'grapheme' }).segment(s)].map((g) => g.segment);

export function createPdfWriter(out, def, meta, { fontSize = 7.5, maxLinesPerCell = 5 } = {}) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true, info: { Title: def.title, Creator: 'GPS PID Portal' } });
  doc.pipe(out);
  for (const [k, p] of Object.entries(FONT_FILES)) doc.registerFont(k, p);

  const M = 28;
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const usable = pageW - 2 * M;
  const totalRel = def.columns.reduce((s, c) => s + c.pdf, 0);
  const widths = def.columns.map((c) => (usable * c.pdf) / totalRel);
  const PAD = 2.5;
  const lineH = fontSize * 1.32;
  const bottom = pageH - M - 22; // footer band
  const fontName = (f, bold) => (bold ? `${f}Bold` : f);

  const width = (text, bold) => scriptRuns(text).reduce((w, r) => w + doc.font(fontName(r.font, bold)).fontSize(fontSize).widthOfString(r.text), 0);

  /** Greedy wrap into ≤ maxLinesPerCell lines; long words break between grapheme clusters only. */
  function wrap(text, maxW, bold) {
    if (!text) return [''];
    const lines = [];
    let cur = '';
    const push = () => { lines.push(cur); cur = ''; };
    for (const tok of String(text).split(/(\s+)/)) {
      if (!tok) continue;
      const cand = cur + tok;
      if (width(cand, bold) <= maxW) { cur = cand; continue; }
      if (/^\s+$/.test(tok)) { push(); continue; }
      if (cur) push();
      if (width(tok, bold) <= maxW) { cur = tok; continue; }
      for (const g of graphemes(tok)) {
        if (cur && width(cur + g, bold) > maxW) push();
        cur += g;
      }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLinesPerCell) {
      const kept = lines.slice(0, maxLinesPerCell);
      kept[maxLinesPerCell - 1] = `${kept[maxLinesPerCell - 1].replace(/\s+$/, '')}…`;
      return kept;
    }
    return lines.map((l) => l.trim());
  }

  // All runs share ONE alphabetic baseline: pdfkit's default positions text by the top of each font's
  // line box, and Noto Sans / Noto Sans Devanagari have different ascents (mixed lines would zig-zag).
  const baselineOffset = fontSize * 1.02;
  function drawLine(text, x, y, bold, color = '#111111') {
    let cx = x;
    for (const r of scriptRuns(text)) {
      doc.font(fontName(r.font, bold)).fontSize(fontSize).fillColor(color)
        .text(r.text, cx, y + baselineOffset, { lineBreak: false, baseline: 'alphabetic' });
      cx += doc.widthOfString(r.text);
    }
  }

  function drawRow(cells, y, { bold = false, fill = null } = {}) {
    const wrapped = cells.map((t, i) => wrap(t, widths[i] - 2 * PAD, bold));
    const h = Math.max(...wrapped.map((l) => l.length)) * lineH + 2 * PAD;
    if (fill) doc.rect(M, y, usable, h).fill(fill);
    let x = M;
    wrapped.forEach((lines, i) => {
      lines.forEach((l, li) => drawLine(l, x + PAD, y + PAD + li * lineH, bold));
      x += widths[i];
    });
    doc.moveTo(M, y + h).lineTo(M + usable, y + h).lineWidth(0.3).strokeColor('#cbd5e1').stroke();
    return h;
  }

  const headers = def.columns.map((c) => c.header);
  let y = 0;
  function pageHeader() {
    y = M;
    // Title at 12 pt (a single Latin run is enough for the static English titles).
    doc.fillColor('#0f172a').font('latinBold').fontSize(12).text(def.title, M, y, { lineBreak: false });
    y += 16;
    drawLine(meta.filterText, M, y, false, '#334155');
    y += lineH;
    drawLine(`Generated ${meta.generatedAtText} (IST) by ${meta.generatedBy} · scope: ${meta.scopeText}`, M, y, false, '#334155');
    y += lineH + 6;
    y += drawRow(headers, y, { bold: true, fill: '#e2e8f0' });
  }
  pageHeader();

  let count = 0;
  return {
    async row(rec) {
      const cells = def.columns.map((c) => displayValue(c.type, rec[c.key]));
      // measure first (drawRow draws), so compute height via wrap without drawing
      const h = Math.max(...cells.map((t, i) => wrap(t, widths[i] - 2 * PAD, false).length)) * lineH + 2 * PAD;
      if (y + h > bottom) {
        doc.addPage();
        pageHeader();
      }
      y += drawRow(cells, y);
      if (++count % 200 === 0) await new Promise((r) => setImmediate(r));
    },
    async finish() {
      if (count === 0) drawLine('No rows match these filters.', M, y + 4, false, '#475569');
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        const keep = doc.page.margins.bottom;
        doc.page.margins.bottom = 0; // writing inside the bottom margin must not add a page
        const fy = pageH - M - 12;
        drawLine(meta.disclaimer, M, fy, false, '#475569');
        const label = `Page ${i + 1} / ${range.count}`;
        doc.font('latin').fontSize(fontSize);
        drawLine(label, pageW - M - doc.widthOfString(label), fy, false, '#475569');
        doc.page.margins.bottom = keep;
      }
      await new Promise((resolve, reject) => {
        out.once('finish', resolve);
        out.once('error', reject);
        doc.end();
      });
    },
  };
}
