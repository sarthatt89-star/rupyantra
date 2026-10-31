'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_WASM = path.join(__dirname, 'wasm', 'finance.wasm');

const LIMITS = Object.freeze({
  maxMonths: 1200,
  minSims: 100,
  maxSims: 200000,
  maxWork: 20000000,
  maxAmount: 1e12
});

const DEFAULT_SEED = 12345;

const ERR_TEXT = {
  1: 'monthly_amount allowed range mein nahi hai',
  2: 'annual_return allowed range mein nahi hai',
  3: 'volatility 0 se 100 ke beech honi chahiye',
  4: 'avadhi galat hai',
  5: 'simulations ki ginti allowed range mein nahi hai',
  6: 'simulation ke liye memory kam padi'
};

const UNAVAILABLE = { ok: false, code: 'ENGINE_UNAVAILABLE', error: 'Simulation engine abhi available nahi hai.' };

function instantiate(file) {
  const mod = new WebAssembly.Module(fs.readFileSync(file));
  const imports = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] = imports[imp.module] || {};
    imports[imp.module][imp.name] = () => 0;
  }
  const instance = new WebAssembly.Instance(mod, imports);
  const e = instance.exports;
  if (typeof e._initialize === 'function') e._initialize();
  if (typeof e.rupeyantra_sip_monte_carlo !== 'function' || !e.memory) throw new Error('wasm exports missing');
  return e;
}

let cached;

function load(file) {
  if (file) {
    try { return instantiate(file); } catch (_) { return null; }
  }
  if (cached === undefined) {
    try { cached = instantiate(DEFAULT_WASM); } catch (_) { cached = null; }
  }
  return cached;
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);

function simulateSip(input, opts = {}) {
  try {
    const a = input && typeof input === 'object' ? input : {};
    const months = Math.round(Number(a.years) * 12);
    const sims = a.simulations === undefined ? 5000 : Math.round(Number(a.simulations));
    const seed = a.seed === undefined ? DEFAULT_SEED : Math.round(Number(a.seed));

    if (![a.monthly_amount, a.annual_return, a.annual_volatility, months, sims, seed].every(isNum) ||
        !(a.monthly_amount > 0) || a.monthly_amount > LIMITS.maxAmount) {
      return { ok: false, code: 'INVALID_INPUT', error: 'Simulation ke inputs sahi nahi hain.' };
    }
    if (months < 1 || months > LIMITS.maxMonths) {
      return { ok: false, code: 'INVALID_INPUT', error: 'Avadhi 1 mahine se 100 saal ke beech honi chahiye.' };
    }
    if (sims < LIMITS.minSims || sims > LIMITS.maxSims || sims * months > LIMITS.maxWork) {
      return { ok: false, code: 'INVALID_INPUT', error: 'Simulations ki ginti is avadhi ke liye bahut zyada hai.' };
    }

    const e = load(opts.file);
    if (!e) return UNAVAILABLE;

    const code = e.rupeyantra_sip_monte_carlo(a.monthly_amount, a.annual_return, a.annual_volatility, months, sims, seed >>> 0);
    if (code !== 0) return { ok: false, code: 'INVALID_INPUT', error: ERR_TEXT[code] || 'Simulation chal nahi paya.' };

    const r = new Float64Array(e.memory.buffer, e.rupeyantra_result_ptr(), e.rupeyantra_result_len());
    const values = {
      invested: r[0], p10: r[1], p50: r[2], p90: r[3], mean: r[4],
      prob_loss_percent: r[5], min: r[6], max: r[7], simulations: sims, months
    };
    if (!Object.values(values).every(isNum)) return UNAVAILABLE;
    return { ok: true, values };
  } catch (_) {
    return UNAVAILABLE;
  }
}

function isAvailable(opts = {}) {
  return Boolean(load(opts.file));
}

module.exports = { simulateSip, isAvailable, LIMITS, DEFAULT_SEED };
