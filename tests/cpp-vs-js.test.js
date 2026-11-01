'use strict';

/*
 * C++ engine vs the existing JavaScript calculators (lib/finance-engine.js).
 * The same random inputs go to both and the answers must agree.
 *
 * Which C++ build is used:
 *   RY_CLI=/path/to/ry_cli  -> the native command-line build (tests/cli.cpp)   [used in GitHub Actions and locally]
 *   otherwise lib/wasm/finance.wasm through lib/cpp-bridge.js                  [skipped if the file does not exist]
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const engine = require('../lib/finance-engine');
const bridge = require('../lib/cpp-bridge');

const CLI = process.env.RY_CLI && fs.existsSync(process.env.RY_CLI) ? process.env.RY_CLI : null;
const WASM = fs.existsSync(path.join(__dirname, '..', 'lib', 'wasm', 'finance.wasm'));
const SKIP = !CLI && !WASM && 'no C++ build available (set RY_CLI or build finance.wasm)';

/* ---- one adapter, two backends: every call returns the result array or null on error ---- */
function cli(cmd) {
  const r = spawnSync(CLI, { input: cmd + '\n', encoding: 'utf8' });
  const line = (r.stdout || '').trim();
  return line.startsWith('ok') ? line.split(/\s+/).slice(1).map(Number) : null;
}
const viaWasm = {
  emi: (P, r, n) => { const x = bridge.emi({ principal: P, annual_rate: r, months: n }); return x.ok ? [x.values.emi, x.values.total_payment, x.values.total_interest, x.values.months] : null; },
  sip: (P, r, n) => { const x = bridge.sip({ monthly_amount: P, annual_return: r, months: n }); return x.ok ? [x.values.invested, x.values.future_value, x.values.gain] : null; },
  lump: (P, r, y, c) => { const x = bridge.lumpsum({ principal: P, annual_rate: r, years: y, compounds_per_year: c }); return x.ok ? [x.values.maturity, x.values.interest] : null; },
  cagr: (a, b, y) => { const x = bridge.cagr({ start_value: a, end_value: b, years: y }); return x.ok ? [x.values.cagr_percent] : null; },
  infl: (a, r, y) => { const x = bridge.inflation({ amount: a, annual_inflation: r, years: y }); return x.ok ? [x.values.future_cost, x.values.extra_cost, x.values.real_value] : null; },
  sched: (P, r, n) => { const x = bridge.emiScheduleYearly({ principal: P, annual_rate: r, months: n }); return x.ok ? x.values.rows : null; }
};
const cpp = CLI ? {
  emi: (P, r, n) => cli(`emi ${P} ${r} ${n}`),
  sip: (P, r, n) => cli(`sip ${P} ${r} ${n}`),
  lump: (P, r, y, c) => cli(`lump ${P} ${r} ${y} ${c}`),
  cagr: (a, b, y) => cli(`cagr ${a} ${b} ${y}`),
  infl: (a, r, y) => cli(`infl ${a} ${r} ${y}`),
  sched: (P, r, n) => { const v = cli(`sched ${P} ${r} ${n}`); if (!v) return null; const rows = []; for (let i = 0; i < v[0]; i++) { const o = 1 + i * 5; rows.push({ year: v[o], opening: v[o + 1], principal_paid: v[o + 2], interest_paid: v[o + 3], closing: v[o + 4] }); } return rows; }
} : viaWasm;

/* ---- helpers ---- */
let seed = 20261101;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const between = (a, b) => a + rnd() * (b - a);
const pick = list => list[Math.floor(rnd() * list.length)];
const inr = s => Number(String(s).replace(/[₹,\s]/g, ''));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: C++ ${a} vs JS ${b}`);
const N = 300;

test('EMI: C++ equals the JS engine (300 random loans)', { skip: SKIP }, () => {
  for (let i = 0; i < N; i++) {
    const P = Math.round(between(10000, 5e8)), rate = Math.round(between(0, 25) * 100) / 100, n = Math.round(between(1, 480));
    const c = cpp.emi(P, rate, n), j = engine.emiNumbers(P, rate, n);
    assert.ok(c, `emi ${P} ${rate} ${n} rejected`);
    near(c[0], j.emi, 1e-6 * Math.max(1, j.emi), `emi ${P}/${rate}/${n}`);
    near(c[2], j.interest, 1e-5 * Math.max(1, P), `interest ${P}/${rate}/${n}`);
  }
});

test('EMI: C++ matches the displayed calc_emi tool', { skip: SKIP }, () => {
  const t = engine.runTool('calc_emi', { principal: 5000000, annual_rate: 8.5, years: 20 });
  const c = cpp.emi(5000000, 8.5, 240);
  near(c[0], t.monthly_emi_exact, 0.01, 'emi');
  near(c[1], inr(t.total_payment), 1, 'total payment');
});

test('SIP: C++ equals the JS engine (300 random plans)', { skip: SKIP }, () => {
  for (let i = 0; i < N; i++) {
    const P = Math.round(between(500, 5e6)), rate = Math.round(between(-10, 30) * 100) / 100, n = Math.round(between(1, 480));
    const c = cpp.sip(P, rate, n), j = engine.sipNumbers(P, rate, n);
    assert.ok(c, `sip ${P} ${rate} ${n} rejected`);
    near(c[1], j.fv, 1e-8 * Math.max(1, j.fv) + 0.01, `sip fv ${P}/${rate}/${n}`);
    near(c[0], j.invested, 1e-6, 'invested');
  }
});

test('Lumpsum: C++ equals calc_lumpsum', { skip: SKIP }, () => {
  for (let i = 0; i < N; i++) {
    const P = Math.round(between(1000, 5e7)), rate = Math.round(between(0, 20) * 100) / 100, y = Math.round(between(1, 30) * 10) / 10, m = pick([1, 2, 4, 12]);
    const c = cpp.lump(P, rate, y, m), j = engine.runTool('calc_lumpsum', { principal: P, annual_rate: rate, years: y, compounds_per_year: m });
    assert.ok(c && !j.error, `lump ${P}/${rate}/${y}/${m}: ${j.error || 'C++ rejected'}`);
    near(c[0], inr(j.maturity_amount), 1, `maturity ${P}/${rate}/${y}/${m}`);
  }
});

test('CAGR: C++ equals calc_cagr', { skip: SKIP }, () => {
  for (let i = 0; i < N; i++) {
    const a = Math.round(between(1000, 1e7)), b = Math.round(a * between(0.3, 8)), y = Math.round(between(1, 30) * 10) / 10;
    const c = cpp.cagr(a, b, y), j = engine.runTool('calc_cagr', { start_value: a, end_value: b, years: y });
    assert.ok(c && !j.error, 'cagr rejected');
    near(c[0], j.cagr_percent, 0.006, `cagr ${a}->${b} in ${y}y`);
  }
});

test('Inflation: C++ equals calc_inflation', { skip: SKIP }, () => {
  for (let i = 0; i < N; i++) {
    const a = Math.round(between(1000, 1e7)), r = Math.round(between(0, 15) * 10) / 10, y = Math.round(between(1, 40));
    const c = cpp.infl(a, r, y), j = engine.runTool('calc_inflation', { current_amount: a, annual_inflation: r, years: y });
    assert.ok(c && !j.error, 'inflation rejected');
    near(c[0], inr(j.future_cost_estimate), 1, `future cost ${a}/${r}/${y}`);
  }
});

test('Yearly schedule: principal adds up to the loan and the last balance is zero', { skip: SKIP }, () => {
  for (let i = 0; i < 100; i++) {
    const P = Math.round(between(50000, 2e8)), rate = Math.round(between(0.5, 20) * 100) / 100, n = Math.round(between(2, 360));
    const rows = cpp.sched(P, rate, n);
    assert.ok(rows && rows.length === Math.ceil(n / 12), 'row count');
    const sumP = rows.reduce((s, r) => s + r.principal_paid, 0), sumI = rows.reduce((s, r) => s + r.interest_paid, 0);
    const j = engine.emiNumbers(P, rate, n);
    near(sumP, P, 0.01 + P * 1e-9, `principal ${P}/${rate}/${n}`);
    near(sumI, j.interest, 0.5 + P * 1e-7, `interest ${P}/${rate}/${n}`);
    near(rows[rows.length - 1].closing, 0, 0.01, 'closing balance');
  }
});

test('Bad inputs are rejected by C++ (no NaN, no negative amounts)', { skip: SKIP }, () => {
  assert.equal(cpp.emi(-1, 8, 12), null);
  assert.equal(cpp.emi(1000, 8, 0), null);
  assert.equal(cpp.emi(1000, 101, 12), null);
  assert.equal(cpp.sip(1000, 500, 12), null);
  assert.equal(cpp.cagr(0, 100, 5), null);
});
