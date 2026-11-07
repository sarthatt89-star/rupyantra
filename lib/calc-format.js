'use strict';

/*
 * Rupeyantra Calc Format (lib/calc-format.js)  --  PHASE 5/6/7
 *
 * Engine ke result ko insaan ke padhne layak text me badalta hai. Chat, PDF aur API teeno isi ka istemal karte hain,
 * taaki ek hi number har jagah ek jaisa dikhe. Koi hisaab nahi hota, sirf dikhana.
 */

const catalog = require('./calculator-catalog');

function groupIndian(whole) {
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
}

// 3558489.47 -> "₹35,58,489.47"   (decimals=0 par "₹35,58,489")
function fmtINR(n, decimals = 2, symbol = '₹') {
  if (!Number.isFinite(n)) return '-';
  const neg = n < 0;
  const [whole, frac] = Math.abs(n).toFixed(decimals).split('.');
  return (neg ? '-' : '') + symbol + groupIndian(whole) + (frac ? '.' + frac : '');
}

function fmtMonths(m) {
  const y = Math.floor(m / 12), r = m % 12;
  const parts = [];
  if (y) parts.push(y + ' saal');
  if (r || !y) parts.push(r + ' mahine');
  return m + ' mahine' + (y ? ' (' + parts.join(' ') + ')' : '');
}

function fmtValue(value, spec, opts = {}) {
  if (value === undefined || value === null) return '-';
  const symbol = opts.plain ? 'Rs. ' : '₹';
  switch (spec.format) {
    case 'inr': return fmtINR(value, spec.decimals === undefined ? 2 : spec.decimals, symbol);
    case 'percent': return Number(value).toFixed(spec.decimals === undefined ? 2 : spec.decimals).replace(/\.?0+$/, '') + '%';
    case 'months': return opts.plain ? value + ' mahine' : fmtMonths(value);
    case 'bool': return value ? 'Haan' : 'Nahi';
    case 'text': return String(value);
    default: return String(value);
  }
}

// env = result envelope (success). Lautata hai { rows:[{label,value,highlight}], table:{columns,rows}|null }
function describeResult(operation, env, opts = {}) {
  const entry = catalog.get(operation);
  if (!entry || !env || !env.result) return null;
  const rows = [];
  for (const spec of entry.result) {
    if (env.result[spec.key] === undefined) continue;
    rows.push({ key: spec.key, label: spec.label, value: fmtValue(env.result[spec.key], spec, opts), highlight: Boolean(spec.highlight) });
  }
  let table = null;
  if (entry.table && Array.isArray(env.result[entry.table.key])) {
    table = {
      columns: entry.table.columns.map(c => c.label),
      rows: env.result[entry.table.key].map(r => entry.table.columns.map(c => fmtValue(r[c.key], c, opts)))
    };
  }
  return { title: entry.title, rows, table };
}

function describeInputs(operation, inputs, opts = {}) {
  const entry = catalog.get(operation);
  if (!entry) return [];
  return entry.fields.filter(f => inputs[f.name] !== undefined).map(f => {
    const unit = f.unit;
    const spec = unit === 'inr' ? { format: 'inr', decimals: 2 } : unit === 'percent' ? { format: 'percent' } : unit === 'months' ? { format: 'months' } : { format: 'number' };
    const v = unit === 'years' ? inputs[f.name] + ' saal' : fmtValue(inputs[f.name], spec, { plain: opts.plain });
    return { label: f.label, value: v };
  });
}

module.exports = { fmtINR, fmtMonths, fmtValue, describeResult, describeInputs };
