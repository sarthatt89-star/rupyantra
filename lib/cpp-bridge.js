'use strict';

/*
 * Rupeyantra C++ bridge (lib/cpp-bridge.js)
 *
 * Loads lib/wasm/finance.wasm (built from cpp-engine/ by GitHub Actions) and exposes the C++ engine
 * as plain synchronous functions. Nothing here throws: every function returns
 *   { ok: true, values: {...} }   or   { ok: false, code, error }
 * so callers can fall back safely. code is ENGINE_UNAVAILABLE or INVALID_INPUT.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_WASM = path.join(__dirname, 'wasm', 'finance.wasm');

const LIMITS = Object.freeze({
  maxMonths: 1200,
  minSims: 100,
  maxSims: 200000,
  maxWork: 20000000, // simulations x months; keeps one call well under a second
  maxAmount: 1e12,
  batchMax: 10000
});

const DEFAULT_SEED = 12345; // same inputs => same answer every time

const ERR_TEXT = {
  1: 'amount allowed range mein nahi hai',
  2: 'return allowed range mein nahi hai',
  3: 'volatility 0 se 100 ke beech honi chahiye',
  4: 'avadhi galat hai',
  5: 'simulations ki ginti allowed range mein nahi hai',
  6: 'simulation ke liye memory kam padi',
  7: 'interest rate 0 se 100 ke beech honi chahiye',
  8: 'extra payment ki details sahi nahi hain',
  9: 'tax ke inputs ya rules sahi nahi hain',
  10: 'rate range ya gap sahi nahi hai',
  11: 'batch mein 1 se 10,000 loans honi chahiye',
  12: 'compounding 1 se 365 ke beech poora number honi chahiye'
};

const UNAVAILABLE = { ok: false, code: 'ENGINE_UNAVAILABLE', error: 'Simulation engine abhi available nahi hai.' };
const invalid = msg => ({ ok: false, code: 'INVALID_INPUT', error: msg || 'Inputs sahi nahi hain.' });
const isNum = v => typeof v === 'number' && Number.isFinite(v);

/* ---------- loading ---------- */

function instantiate(file) {
  const mod = new WebAssembly.Module(fs.readFileSync(file));
  const imports = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] = imports[imp.module] || {};
    imports[imp.module][imp.name] = () => 0; // toolchain stubs; our code never uses them
  }
  const e = new WebAssembly.Instance(mod, imports).exports;
  if (typeof e._initialize === 'function') e._initialize();
  if (typeof e.rupeyantra_result_ptr !== 'function' || !e.memory) throw new Error('wasm exports missing');
  return e;
}

let cached; // undefined = not tried, null = failed, object = ready

function load(file) {
  if (file) {
    try { return instantiate(file); } catch (_) { return null; }
  }
  if (cached === undefined) {
    try { cached = instantiate(DEFAULT_WASM); } catch (_) { cached = null; }
  }
  return cached;
}

function engineOf(opts) {
  return (opts && opts.exports) || load(opts && opts.file);
}

/* ---------- generic call ---------- */

// prep(e) runs before the call (used to fill input buffers); reader(resultArray, e) shapes the values
function invoke(opts, fn, args, reader, prep) {
  try {
    if (!args.every(isNum)) return invalid();
    const e = engineOf(opts);
    if (!e || typeof e[fn] !== 'function' || !e.memory) return UNAVAILABLE;
    if (prep) prep(e);
    const code = e[fn](...args);
    if (code !== 0) return invalid(ERR_TEXT[code]);
    const len = e.rupeyantra_result_len();
    const r = Array.from(new Float64Array(e.memory.buffer, e.rupeyantra_result_ptr(), len)); // read after the call: memory may have grown
    if (!r.every(isNum)) return UNAVAILABLE;
    return { ok: true, values: reader(r, e) };
  } catch (_) {
    return UNAVAILABLE;
  }
}

const int = v => (isNum(v) ? Math.round(v) : NaN);
const monthsOf = a => (isNum(a.months) ? int(a.months) : int(Number(a.years) * 12));

function simsCheck(months, sims) {
  if (!(months >= 1 && months <= LIMITS.maxMonths)) return invalid('Avadhi 1 mahine se 100 saal ke beech honi chahiye.');
  if (!(sims >= LIMITS.minSims && sims <= LIMITS.maxSims && sims * months <= LIMITS.maxWork)) {
    return invalid('Simulations ki ginti is avadhi ke liye bahut zyada hai.');
  }
  return null;
}

/* ---------- loans ---------- */

function emi(a, opts) {
  a = a || {};
  return invoke(opts, 'rupeyantra_emi', [Number(a.principal), Number(a.annual_rate), monthsOf(a)],
    r => ({ emi: r[0], total_payment: r[1], total_interest: r[2], months: r[3] }));
}

function emiScheduleYearly(a, opts) {
  a = a || {};
  return invoke(opts, 'rupeyantra_emi_schedule_yearly', [Number(a.principal), Number(a.annual_rate), monthsOf(a)], r => {
    const rows = [];
    for (let i = 0; i < r[0]; i++) {
      const o = 1 + i * 5;
      rows.push({ year: r[o], opening: r[o + 1], principal_paid: r[o + 2], interest_paid: r[o + 3], closing: r[o + 4] });
    }
    return { rows };
  });
}

function loanPrepayment(a, opts) {
  a = a || {};
  const extra = a.extra_monthly === undefined ? 0 : Number(a.extra_monthly);
  const lump = a.lump_sum === undefined ? 0 : Number(a.lump_sum);
  const after = a.lump_after_month === undefined ? 0 : int(a.lump_after_month);
  return invoke(opts, 'rupeyantra_loan_prepayment', [Number(a.principal), Number(a.annual_rate), monthsOf(a), extra, lump, after],
    r => ({
      base_emi: r[0], base_months: r[1], base_interest: r[2], new_months: r[3], new_interest: r[4],
      interest_saved: r[5], months_saved: r[6], total_paid: r[7]
    }));
}

function emiRateSweep(a, opts) {
  a = a || {};
  return invoke(opts, 'rupeyantra_emi_rate_sweep',
    [Number(a.principal), monthsOf(a), Number(a.rate_from), Number(a.rate_to), Number(a.step)],
    r => {
      const rows = [];
      for (let i = 0; i < r[0]; i++) {
        const o = 1 + i * 3;
        rows.push({ rate: r[o], emi: r[o + 1], total_interest: r[o + 2] });
      }
      return { rows };
    });
}

// rows: [[principal, annual_rate, months], ...]
function emiBatch(rows, opts) {
  try {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > LIMITS.batchMax) return invalid(ERR_TEXT[11]);
    const flat = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 3) return invalid();
      flat.push(Number(row[0]), Number(row[1]), Number(row[2]));
    }
    return invoke(opts, 'rupeyantra_emi_batch', [rows.length],
      (r, e) => {
        const out = new Float64Array(e.memory.buffer, e.rupeyantra_batch_out_ptr(), rows.length * 2);
        const results = [];
        for (let i = 0; i < rows.length; i++) results.push({ emi: out[i * 2], total_interest: out[i * 2 + 1] });
        return { invalid: r[0], count: r[1], results };
      },
      e => {
        const inp = new Float64Array(e.memory.buffer, e.rupeyantra_batch_in_ptr(), rows.length * 3);
        for (let i = 0; i < flat.length; i++) inp[i] = Number.isFinite(flat[i]) ? flat[i] : 0; // bad numbers become 0 => counted invalid
      });
  } catch (_) {
    return UNAVAILABLE;
  }
}

/* ---------- investments ---------- */

function sip(a, opts) {
  a = a || {};
  return invoke(opts, 'rupeyantra_sip', [Number(a.monthly_amount), Number(a.annual_return), monthsOf(a)],
    r => ({ invested: r[0], future_value: r[1], gain: r[2] }));
}

function lumpsum(a, opts) {
  a = a || {};
  const m = a.compounds_per_year === undefined ? 4 : int(a.compounds_per_year);
  return invoke(opts, 'rupeyantra_lumpsum', [Number(a.principal), Number(a.annual_rate), Number(a.years), m],
    r => ({ maturity: r[0], interest: r[1] }));
}

function cagr(a, opts) {
  a = a || {};
  return invoke(opts, 'rupeyantra_cagr', [Number(a.start_value), Number(a.end_value), Number(a.years)],
    r => ({ cagr_percent: r[0] }));
}

function inflation(a, opts) {
  a = a || {};
  return invoke(opts, 'rupeyantra_inflation', [Number(a.amount), Number(a.annual_inflation), Number(a.years)],
    r => ({ future_cost: r[0], extra_cost: r[1], real_value: r[2] }));
}

function realReturn(a, opts) {
  a = a || {};
  return invoke(opts, 'rupeyantra_real_return', [Number(a.nominal), Number(a.inflation)],
    r => ({ real_return_percent: r[0] }));
}

/* ---------- simulations ---------- */

const mcValues = (r, sims, months) => ({
  invested: r[0], p10: r[1], p50: r[2], p90: r[3], mean: r[4],
  prob_loss_percent: r[5], min: r[6], max: r[7], simulations: sims, months
});

// { monthly_amount, annual_return, annual_volatility, years, simulations?, seed? }
function simulateSip(a, opts) {
  a = a && typeof a === 'object' ? a : {};
  const months = monthsOf(a);
  const sims = a.simulations === undefined ? 5000 : int(a.simulations);
  const seed = a.seed === undefined ? DEFAULT_SEED : int(a.seed);
  if (![a.monthly_amount, a.annual_return, a.annual_volatility, months, sims, seed].every(isNum) || !(a.monthly_amount > 0) || a.monthly_amount > LIMITS.maxAmount) {
    return invalid('Simulation ke inputs sahi nahi hain.');
  }
  const bad = simsCheck(months, sims);
  if (bad) return bad;
  return invoke(opts, 'rupeyantra_sip_monte_carlo', [a.monthly_amount, a.annual_return, a.annual_volatility, months, sims, seed >>> 0],
    r => mcValues(r, sims, months));
}

// { principal, annual_return, annual_volatility, years, compounds_per_year?, simulations?, seed? }
function simulateLumpsum(a, opts) {
  a = a && typeof a === 'object' ? a : {};
  const months = monthsOf(a);
  const sims = a.simulations === undefined ? 5000 : int(a.simulations);
  const seed = a.seed === undefined ? DEFAULT_SEED : int(a.seed);
  const cpy = a.compounds_per_year === undefined ? 1 : int(a.compounds_per_year);
  if (![a.principal, a.annual_return, a.annual_volatility, months, sims, seed, cpy].every(isNum) || !(a.principal > 0) || a.principal > LIMITS.maxAmount) {
    return invalid('Simulation ke inputs sahi nahi hain.');
  }
  const bad = simsCheck(months, sims);
  if (bad) return bad;
  return invoke(opts, 'rupeyantra_lumpsum_monte_carlo', [a.principal, a.annual_return, a.annual_volatility, months, cpy, sims, seed >>> 0],
    r => mcValues(r, sims, months));
}

// { monthly_amount, annual_return, annual_volatility, years, target_amount, simulations?, seed? }
function sipGoalProbability(a, opts) {
  a = a && typeof a === 'object' ? a : {};
  const months = monthsOf(a);
  const sims = a.simulations === undefined ? 5000 : int(a.simulations);
  const seed = a.seed === undefined ? DEFAULT_SEED : int(a.seed);
  if (![a.monthly_amount, a.annual_return, a.annual_volatility, a.target_amount, months, sims, seed].every(isNum)) {
    return invalid('Simulation ke inputs sahi nahi hain.');
  }
  const bad = simsCheck(months, sims);
  if (bad) return bad;
  return invoke(opts, 'rupeyantra_sip_goal_probability',
    [a.monthly_amount, a.annual_return, a.annual_volatility, months, a.target_amount, sims, seed >>> 0],
    r => ({ probability_percent: r[0], median: r[1] }));
}

/* ---------- tax ---------- */

const TAXIN = { INCOME: 0, SLABS: 1, SLAB0: 2, REBATE_LIMIT: 22, REBATE_MAX: 23, REBATE_RELIEF: 24, SURCH_COUNT: 25, SURCH0: 26, CESS: 38 };

// rules: { slabs: [[upper, rate]...], rebate_limit, rebate_max, rebate_relief, surcharge: [[above, rate]...], cess }
function taxCompute(income, rules, opts) {
  try {
    const r = rules && typeof rules === 'object' ? rules : {};
    const slabs = Array.isArray(r.slabs) ? r.slabs : [];
    const sur = Array.isArray(r.surcharge) ? r.surcharge : [];
    if (slabs.length < 1 || slabs.length > 10 || sur.length > 6) return invalid(ERR_TEXT[9]);
    return invoke(opts, 'rupeyantra_tax_compute', [], rr => ({
      slab_tax: rr[0], rebate: rr[1], tax_after_rebate: rr[2], surcharge: rr[3], cess: rr[4],
      total_tax: rr[5], effective_rate_percent: rr[6], monthly_tax: rr[7], total_tax_rounded: rr[8]
    }), e => {
      const inp = new Float64Array(e.memory.buffer, e.rupeyantra_input_ptr(), e.rupeyantra_input_len());
      inp.fill(0);
      inp[TAXIN.INCOME] = Number(income);
      inp[TAXIN.SLABS] = slabs.length;
      slabs.forEach(([upper, rate], i) => { inp[TAXIN.SLAB0 + 2 * i] = Number(upper); inp[TAXIN.SLAB0 + 2 * i + 1] = Number(rate); });
      inp[TAXIN.REBATE_LIMIT] = Number(r.rebate_limit || 0);
      inp[TAXIN.REBATE_MAX] = Number(r.rebate_max || 0);
      inp[TAXIN.REBATE_RELIEF] = r.rebate_relief ? 1 : 0;
      inp[TAXIN.SURCH_COUNT] = sur.length;
      sur.forEach(([above, rate], i) => { inp[TAXIN.SURCH0 + 2 * i] = Number(above); inp[TAXIN.SURCH0 + 2 * i + 1] = Number(rate); });
      inp[TAXIN.CESS] = Number(r.cess || 0);
    });
  } catch (_) {
    return UNAVAILABLE;
  }
}

/* ---------- info ---------- */

function version(opts) {
  try {
    const e = engineOf(opts);
    return e && typeof e.rupeyantra_version === 'function' ? e.rupeyantra_version() : 0;
  } catch (_) {
    return 0;
  }
}

function isAvailable(opts) {
  return version(opts) > 0;
}

module.exports = {
  LIMITS, DEFAULT_SEED,
  emi, emiScheduleYearly, loanPrepayment, emiRateSweep, emiBatch,
  sip, lumpsum, cagr, inflation, realReturn,
  simulateSip, simulateLumpsum, sipGoalProbability,
  taxCompute,
  version, isAvailable
};
