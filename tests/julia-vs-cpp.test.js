'use strict';

/*
 * Julia vs the C++/WASM engine: same Monte Carlo inputs, results must agree statistically.
 * (Random streams differ, so exact digits differ; with volatility 0 both must equal the closed form exactly.)
 * Runs only when a Julia executable is available:  RY_JULIA=julia  (GitHub Actions sets it). Otherwise skipped.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bridge = require('../lib/cpp-bridge');

const JULIA = process.env.RY_JULIA || '';
const WASM = fs.existsSync(path.join(__dirname, '..', 'lib', 'wasm', 'finance.wasm'));
const SKIP = (!JULIA && 'RY_JULIA not set (Julia not installed here)') || (!WASM && 'finance.wasm not built');
const PROJECT = path.join(__dirname, '..', 'julia-engine');

function julia(fn, args) {
  const r = spawnSync(JULIA, ['--project=' + PROJECT, '-t', '2', path.join(PROJECT, 'bin', 'run.jl')],
    { input: JSON.stringify({ fn, args }), encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, 'julia exited with ' + r.status + ': ' + (r.stderr || '').slice(0, 500));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));

test('Julia answers carry evidence that Julia ran', { skip: SKIP }, () => {
  const j = julia('sip_monte_carlo', { monthly_amount: 10000, annual_return: 12, annual_volatility: 0, months: 120, simulations: 100 });
  assert.equal(j.ok, true);
  assert.equal(j.engine, 'julia');
  assert.match(j.julia_version, /^\d+\.\d+/);
});

test('SIP, zero volatility: Julia == C++ == closed form', { skip: SKIP }, () => {
  for (const [P, r, m] of [[10000, 12, 120], [500, 0, 36], [250000, 25, 240], [10000, -6, 24]]) {
    const j = julia('sip_monte_carlo', { monthly_amount: P, annual_return: r, annual_volatility: 0, months: m, simulations: 100 }).result;
    const c = bridge.simulateSip({ monthly_amount: P, annual_return: r, annual_volatility: 0, months: m, simulations: 100 });
    assert.equal(c.ok, true);
    assert.ok(rel(j.p50, c.values.p50) < 1e-9, `p50 ${P}/${r}/${m}: julia ${j.p50} vs cpp ${c.values.p50}`);
  }
});

test('SIP with volatility: Julia and C++ agree statistically (20000 sims)', { skip: SKIP }, () => {
  for (const [P, r, v, m] of [[10000, 12, 15, 120], [5000, 10, 25, 180], [20000, 8, 10, 60]]) {
    const j = julia('sip_monte_carlo', { monthly_amount: P, annual_return: r, annual_volatility: v, months: m, simulations: 20000 }).result;
    const c = bridge.simulateSip({ monthly_amount: P, annual_return: r, annual_volatility: v, months: m, simulations: 20000 }).values;
    for (const k of ['p10', 'p50', 'p90', 'mean']) assert.ok(rel(j[k], c[k]) < 0.03, `${k} ${P}/${r}/${v}/${m}: julia ${j[k]} vs cpp ${c[k]}`);
    assert.ok(Math.abs(j.prob_loss_percent - c.prob_loss_percent) < 2, 'loss probability');
  }
});

test('Lumpsum: Julia and C++ agree', { skip: SKIP }, () => {
  for (const [P, r, v, m, cpy] of [[100000, 12, 0, 60, 1], [100000, 12, 0, 60, 4], [200000, 9, 18, 120, 1]]) {
    const j = julia('lumpsum_monte_carlo', { principal: P, annual_return: r, annual_volatility: v, months: m, compounds_per_year: cpy, simulations: 20000 }).result;
    const c = bridge.simulateLumpsum({ principal: P, annual_return: r, annual_volatility: v, months: m, compounds_per_year: cpy, simulations: 20000 }).values;
    assert.ok(rel(j.p50, c.p50) < (v === 0 ? 1e-9 : 0.03), `p50 ${P}/${r}/${v}/${m}/${cpy}: julia ${j.p50} vs cpp ${c.p50}`);
  }
});

test('Julia refuses unapproved functions and bad input', { skip: SKIP }, () => {
  assert.equal(julia('run_shell', {}).code, 'NOT_APPROVED');
  assert.equal(julia('sip_monte_carlo', { monthly_amount: -1, annual_return: 10, annual_volatility: 5, months: 12 }).code, 'INVALID_INPUT');
});
