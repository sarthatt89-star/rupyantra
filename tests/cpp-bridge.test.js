'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bridge = require('../lib/cpp-bridge');
const WASM = path.join(__dirname, '..', 'lib', 'wasm', 'finance.wasm');
const haveWasm = fs.existsSync(WASM);

test('missing wasm file => clean "unavailable" result, no throw', () => {
  const r = bridge.simulateSip(
    { monthly_amount: 10000, annual_return: 12, annual_volatility: 0, years: 10 },
    { file: '/no/such/file.wasm' }
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ENGINE_UNAVAILABLE');
});

test('bad inputs are rejected before touching wasm', () => {
  const bad = [
    { monthly_amount: -1, annual_return: 12, annual_volatility: 10, years: 10 },
    { monthly_amount: 1000, annual_return: 12, annual_volatility: 10, years: 0 },
    { monthly_amount: 1000, annual_return: 12, annual_volatility: 10, years: 200 },
    { monthly_amount: 1000, annual_return: 12, annual_volatility: 10, years: 10, simulations: 10 },
    { monthly_amount: 1000, annual_return: 12, annual_volatility: 10, years: 100, simulations: 200000 },
    { monthly_amount: 'abc', annual_return: 12, annual_volatility: 10, years: 10 },
    null
  ];
  for (const b of bad) assert.equal(bridge.simulateSip(b).code, 'INVALID_INPUT', JSON.stringify(b));
});

test('wasm: zero volatility equals the SIP known answer', { skip: !haveWasm && 'finance.wasm not built yet' }, () => {
  const r = bridge.simulateSip({ monthly_amount: 10000, annual_return: 12, annual_volatility: 0, years: 10 });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.values.p50 - 2323390.7635) < 0.01);
  assert.equal(r.values.invested, 1200000);
});

test('wasm: p10 <= p50 <= p90 and same inputs give same output', { skip: !haveWasm && 'finance.wasm not built yet' }, () => {
  const input = { monthly_amount: 10000, annual_return: 12, annual_volatility: 15, years: 10 };
  const a = bridge.simulateSip(input);
  const b = bridge.simulateSip(input);
  assert.equal(a.ok, true);
  assert.ok(a.values.p10 <= a.values.p50 && a.values.p50 <= a.values.p90);
  assert.deepEqual(a.values, b.values);
});
