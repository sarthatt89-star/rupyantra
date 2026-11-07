'use strict';

/*
 * Rupeyantra PDF Report (lib/pdf-report.js)  --  PHASE 7
 *
 * Ek calculation ki saaf PDF report, bina kisi bahari package ke (seedha PDF text format likhta hai).
 * Font standard Helvetica hai (₹ nishan us font me nahi hota), isliye report me "Rs." likha jaata hai.
 * Sirf Latin akshar chalte hain (Hinglish romanised hai, isliye theek). Anjaan akshar '?' ban jaate hain.
 */

const calcFormat = require('./calc-format');
const catalog = require('./calculator-catalog');

const PAGE_W = 595, PAGE_H = 842, MARGIN = 50;

function esc(text) {
  return String(text).replace(/₹/g, 'Rs.').replace(/[^\x20-\x7E]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Helvetica ki chaudai ka mota andaza (har akshar ~0.52 em), wrap ke liye
function wrap(text, size, maxWidth) {
  const maxChars = Math.max(10, Math.floor(maxWidth / (size * 0.52)));
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if ((line + ' ' + word).trim().length > maxChars) { if (line) out.push(line); line = word; } else line = (line + ' ' + word).trim();
    }
    out.push(line);
  }
  return out;
}

// blocks: [{ text, size?, bold?, gap? }] -> Buffer (PDF)
function buildPdf(blocks, meta = {}) {
  const pages = [];
  let cur = [];
  let y = PAGE_H - MARGIN;
  const newPage = () => { pages.push(cur); cur = []; y = PAGE_H - MARGIN; };

  for (const b of blocks) {
    const size = b.size || 11;
    const lead = size * 1.4;
    const lines = wrap(b.text, size, PAGE_W - 2 * MARGIN - (b.indent || 0));
    if (b.gap) y -= b.gap;
    for (const line of lines) {
      if (y - lead < MARGIN) newPage();
      cur.push({ x: MARGIN + (b.indent || 0), y: y - size, size, bold: Boolean(b.bold), text: line });
      y -= lead;
    }
  }
  pages.push(cur);

  const objs = [];
  const add = s => { objs.push(s); return objs.length; };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageIds = [];
  pages.forEach((items, idx) => {
    const footer = { x: MARGIN, y: 28, size: 8, bold: false, text: (meta.footer || 'Rupeyantra') + '  |  Page ' + (idx + 1) + ' of ' + pages.length };
    const content = items.concat([footer]).map(it => 'BT /' + (it.bold ? 'F2' : 'F1') + ' ' + it.size + ' Tf ' + it.x + ' ' + it.y.toFixed(1) + ' Td (' + esc(it.text) + ') Tj ET').join('\n');
    const contentId = add('<< /Length ' + Buffer.byteLength(content, 'latin1') + ' >>\nstream\n' + content + '\nendstream');
    pageIds.push(add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] /Resources << /Font << /F1 ' + fontId + ' 0 R /F2 ' + boldId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>'));
  });
  objs[catalogId - 1] = '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>';
  objs[pagesId - 1] = '<< /Type /Pages /Kids [' + pageIds.map(i => i + ' 0 R').join(' ') + '] /Count ' + pageIds.length + ' >>';
  const infoId = add('<< /Title (' + esc(meta.title || 'Rupeyantra report') + ') /Producer (Rupeyantra) >>');

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalogId + ' 0 R /Info ' + infoId + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

// Success envelope se report ke blocks
function reportBlocks(operation, env, opts = {}) {
  const entry = catalog.get(operation);
  const d = calcFormat.describeResult(operation, env, { plain: true });
  if (!entry || !d) return null;
  const blocks = [
    { text: 'Rupeyantra - ' + entry.title, size: 18, bold: true },
    { text: 'Report banane ki tareekh: ' + (opts.date || new Date().toISOString().slice(0, 10)), size: 9, gap: 2 },
    { text: 'Aapke diye hue numbers', size: 13, bold: true, gap: 16 }
  ];
  for (const r of calcFormat.describeInputs(operation, env.inputs, { plain: true })) blocks.push({ text: r.label + ': ' + r.value, indent: 10 });
  blocks.push({ text: 'Result', size: 13, bold: true, gap: 14 });
  for (const r of d.rows) blocks.push({ text: r.label + ': ' + r.value, bold: r.highlight, indent: 10 });
  if (d.table) {
    blocks.push({ text: d.table.columns.join('  |  '), bold: true, gap: 8, indent: 10 });
    for (const row of d.table.rows) blocks.push({ text: row.join('  |  '), indent: 10 });
  }
  blocks.push({ text: 'Maani hui baatein (assumptions)', size: 13, bold: true, gap: 14 });
  for (const a of env.assumptions || []) blocks.push({ text: '- ' + a, indent: 10 });
  if (entry.projection) blocks.push({ text: 'Ye anuman hai, pakka return nahi.', bold: true, indent: 10, gap: 4 });
  blocks.push({ text: 'Jaanch', size: 13, bold: true, gap: 14 });
  blocks.push({ text: 'Hisaab ' + String(env.engine || '').toUpperCase() + ' engine se nikla. ' + (env.verified ? 'Alag tareeke se jaanch pass hui' + (env.verified_by ? ' (' + env.verified_by + ')' : '') + '.' : 'Alag jaanch nahi hui.'), indent: 10 });
  if (entry.sources && entry.sources.length) {
    blocks.push({ text: 'Official sites (mukhya website)', size: 13, bold: true, gap: 14 });
    for (const s of entry.sources) blocks.push({ text: s.name + ': ' + s.url, indent: 10 });
  }
  blocks.push({ text: 'Ye report sirf jaankari ke liye hai, nivesh, tax ya kanooni salaah nahi. Asli faisle se pehle bank ya SEBI-registered salaahkaar se puchhein.', size: 9, gap: 16 });
  return blocks;
}

function buildReport(operation, env, opts = {}) {
  const blocks = reportBlocks(operation, env, opts);
  if (!blocks) return null;
  const entry = catalog.get(operation);
  return buildPdf(blocks, { title: 'Rupeyantra - ' + entry.title, footer: 'Rupeyantra - ' + entry.title });
}

module.exports = { buildPdf, buildReport, reportBlocks, wrap };
