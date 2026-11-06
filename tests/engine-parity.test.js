'use strict';

/*
 * Phase 2 (b): adapters + independent verifier + JS vs C++ parity (contract ke raste se).
 * C++ ke liye: RY_CLI (native build) ya lib/wasm/finance.wasm. Dono na hon to C++ wale tests skip hote hain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const contracts = require('../lib/contracts');
const verifier = require('../lib/engine-verifier');
const { createJsAdapter } = require('../lib/adapter-js');
const { createCppAdapter } = require('../lib/adapter-cpp');
const { createRemoteAdapter } = require('../lib/adapter-remote');
const { createEngineSystem } = require('../lib/engine-system');

const CLI = process.env.RY_CLI && fs.existsSync(process.env.RY_CLI) ? process.env.RY_CLI : null;
const realBridge = require('../lib/cpp-bridge');
const WASM = realBridge.isAvailable();

function cli(cmd) {
  const r = spawnSync(CLI, { input: cmd + '\n', encoding: 'utf8' });
  const line = (r.stdout || '').trim();
  return line.startsWith('ok') ? line.split(/\s+/).slice(1).map(Number) : null;
}
const wrap = (arr, f) => (arr ? { ok: true, values: f(arr) } : { ok: false, code: 'INVALID_INPUT', error: 'rejected' });
const cliBridge = {
  isAvailable: () => true,
  emi: a => wrap(cli(`emi ${a.principal} ${a.annual_rate} ${a.months}`), r => ({ emi: r[0], total_payment: r[1], total_interest: r[2], months: r[3] })),
  sip: a => wrap(cli(`sip ${a.monthly_amount} ${a.annual_return} ${a.months}`), r => ({ invested: r[0], future_value: r[1], gain: r[2] })),
  lumpsum: a => wrap(cli(`lump ${a.principal} ${a.annual_rate} ${a.years} ${a.compounds_per_year}`), r => ({ maturity: r[0], interest: r[1] })),
  cagr: a => wrap(cli(`cagr ${a.start_value} ${a.end_value} ${a.years}`), r => ({ cagr_percent: r[0] })),
  inflation: a => wrap(cli(`infl ${a.amount} ${a.annual_inflation} ${a.years}`), r => ({ future_cost: r[0], extra_cost: r[1], real_value: r[2] }))
};
const bridge = CLI ? cliBridge : WASM ? realBridge : null;
const SKIP_CPP = !bridge && 'C++ build nahi mila (RY_CLI ya lib/wasm/finance.wasm chahiye)';

const mk = (operation, inputs) => {
  const t = contracts.createTask({ operation, inputs });
  assert.equal(t.ok, true, JSON.stringify(t.errors));
  return t.task;
};

const CASES = [
  ['loan.emi', { principal: 5000000, annual_rate: 8.5, years: 20 }],
  ['loan.emi', { principal: 250000, annual_rate: 0, months: 36 }],
  ['loan.compare_emi', { principal: 5000000, annual_rate: 8.5, years: 20, alt_annual_rate: 9, alt_years: 15 }],
  ['invest.sip', { monthly_amount: 10000, annual_return: 12, years: 10 }],
  ['invest.compare_sip', { monthly_amount: 10000, years: 10 }],
  ['invest.lumpsum', { principal: 100000, annual_rate: 7, years: 5 }],
  ['invest.lumpsum', { principal: 100000, annual_rate: 7, years: 5, compounds_per_year: 12 }],
  ['invest.cagr', { start_value: 100000, end_value: 200000, years: 5 }],
  ['inflation.future_cost', { current_amount: 100000, annual_inflation: 6, years: 10 }]
];

// result mein se saare numbers (path ke saath) nikalta hai
function flat(x, p = '', out = {}) {
  if (typeof x === 'number') out[p] = x;
  else if (Array.isArray(x)) x.forEach((v, i) => flat(v, p + '[' + i + ']', out));
  else if (x && typeof x === 'object') for (const k of Object.keys(x)) flat(x[k], p ? p + '.' + k : k, out);
  return out;
}

test('JS adapter: sab 10 operations contract result dete hain aur verifier pass karta hai', async () => {
  const js = createJsAdapter();
  const all = [
    ...CASES,
    ['interest.simple', { principal: 100000, annual_rate: 8, years: 3 }],
    ['tax.gst', { amount: 1000, gst_rate: 18, inclusive: 0 }],
    ['tax.gst', { amount: 1180, gst_rate: 18, inclusive: 1 }],
    ['budget.summary', { monthly_income: 100000, monthly_expenses: 60000, goal_amount: 500000, current_savings: 10000, annual_return: 8 }]
  ];
  const seen = new Set();
  for (const [op, inputs] of all) {
    const task = mk(op, inputs);
    const out = await js.run(task);
    const env = contracts.createResult(task, { ...out, engine: 'js', route_reason: 'test' });
    assert.equal(contracts.validateResultFor(op, env).ok, true, op);
    const v = verifier.verify(task, env);
    assert.equal(v.ok, true, op + ': ' + v.message);
    seen.add(op);
  }
  assert.equal(seen.size, 10);
});

test('golden case: EMI 43,391.16 aur interest 54,13,878.80 (JS)', async () => {
  const task = mk('loan.emi', { principal: 5000000, annual_rate: 8.5, years: 20 });
  const out = await createJsAdapter().run(task);
  assert.ok(Math.abs(out.result.monthly_emi - 43391.16) < 0.011);
  assert.ok(Math.abs(out.result.total_interest - 5413878.8) <= 1);
});

test('JS ka galat input => validation error (fallback ki zaroorat nahi)', async () => {
  const js = createJsAdapter({ engine: { runTool: () => ({ error: 'rate galat' }) } });
  await assert.rejects(() => js.run(mk('loan.emi', { principal: 100000, annual_rate: 8, years: 5 })), e => e.name === 'ValidationError');
});

test('verifier: tampered result pakda jaata hai', async () => {
  const task = mk('loan.emi', { principal: 5000000, annual_rate: 8.5, years: 20 });
  const out = await createJsAdapter().run(task);
  out.result.monthly_emi += 5;
  const env = contracts.createResult(task, { ...out, engine: 'js', route_reason: 'x' });
  const v = verifier.verify(task, env);
  assert.equal(v.ok, false);
  assert.match(v.message, /emi/);
});

test('verifier: result na ho ya operation anjaan ho to ok:false', () => {
  assert.equal(verifier.verify({ operation: 'loan.emi', inputs: {} }, { result: null }).ok, false);
  assert.equal(verifier.verify({ operation: 'x.y', inputs: {} }, { result: {} }).ok, false);
});

test('C++ adapter: unavailable bridge => error (chupke se kuch nahi)', async () => {
  const dead = { isAvailable: () => false, emi: () => ({ ok: false, code: 'ENGINE_UNAVAILABLE', error: 'nahi hai' }) };
  const cpp = createCppAdapter({ bridge: dead });
  await assert.rejects(() => cpp.run(mk('loan.emi', { principal: 100000, annual_rate: 8, years: 5 })), e => e.name === 'EngineUnavailable');
});

test('C++ adapter sirf wahi operations register karta hai jo C++ mein hain', () => {
  const ops = createCppAdapter({ bridge: {} }).capability.operations;
  for (const o of ['interest.simple', 'tax.gst', 'budget.summary']) assert.ok(!ops.includes(o), o);
  assert.equal(ops.length, 7);
});

test('JS vs C++: har shared operation par jawab Rs 1 / 0.01% ke andar milta hai', { skip: SKIP_CPP }, async () => {
  const js = createJsAdapter();
  const cpp = createCppAdapter({ bridge });
  for (const [op, inputs] of CASES) {
    const task = mk(op, inputs);
    const a = flat((await js.run(task)).result);
    const outC = await cpp.run(task);
    const b = flat(outC.result);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), op + ' result ka shape alag hai');
    for (const k of Object.keys(a)) {
      const tol = k.includes('percent') || k.includes('rate') ? 0.011 : /months|years|compounds/.test(k) ? 1e-9 : Math.max(1, (task.inputs.years || 1) * 12 * 0.011);
      assert.ok(Math.abs(a[k] - b[k]) <= tol, `${op} ${k}: js ${a[k]} vs cpp ${b[k]}`);
    }
    const env = contracts.createResult(task, { ...outC, engine: 'cpp', route_reason: 'x' });
    assert.equal(contracts.validateResultFor(op, env).ok, true, op + ' (cpp envelope)');
    assert.equal(verifier.verify(task, env).ok, true, op + ' (cpp verified)');
  }
});

test('JS vs C++: 150 random EMI/SIP cases', { skip: SKIP_CPP }, async () => {
  let seed = 424242;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const js = createJsAdapter();
  const cpp = createCppAdapter({ bridge });
  for (let i = 0; i < 75; i++) {
    const t1 = mk('loan.emi', { principal: Math.round(10000 + rnd() * 5e7), annual_rate: Math.round(rnd() * 2500) / 100, months: Math.round(1 + rnd() * 479) });
    const a = (await js.run(t1)).result, b = (await cpp.run(t1)).result;
    assert.ok(Math.abs(a.monthly_emi - b.monthly_emi) <= 0.011, 'emi ' + JSON.stringify(t1.inputs));
    const t2 = mk('invest.sip', { monthly_amount: Math.round(500 + rnd() * 1e5), annual_return: Math.round(rnd() * 2000) / 100, years: Math.round(1 + rnd() * 29) });
    const c = (await js.run(t2)).result, d = (await cpp.run(t2)).result;
    assert.ok(Math.abs(c.future_value - d.future_value) <= 1 + c.future_value * 1e-9, 'sip ' + JSON.stringify(t2.inputs));
  }
});

test('system: JS hamesha jura; C++ tabhi jab sach mein load ho; remote tab tak nahi jab tak URL na ho', () => {
  const s = createEngineSystem({ cppBridge: null, env: {} });
  assert.deepEqual(s.status().connected, ['js-reference']);
  assert.equal(s.status().skipped.length, 4);
  if (bridge) {
    const s2 = createEngineSystem({ cppBridge: bridge, env: {} });
    assert.deepEqual(s2.status().connected, ['js-reference', 'cpp-wasm']);
  }
});

test('system: C++ pehle chalta hai, C++ toote to JS jawab deta hai aur fallback likha jaata hai', { skip: SKIP_CPP }, async () => {
  let s = createEngineSystem({ cppBridge: bridge, env: {} });
  const task = mk('loan.emi', { principal: 5000000, annual_rate: 8.5, years: 20 });
  let r = await s.execute(task);
  assert.equal(r.status, 'success');
  assert.equal(r.engine, 'cpp');
  assert.equal(r.verified, true);
  assert.ok(Math.abs(r.result.monthly_emi - 43391.16) < 0.011);

  const broken = { ...bridge, emi: () => ({ ok: false, code: 'ENGINE_UNAVAILABLE', error: 'down' }) };
  s = createEngineSystem({ cppBridge: broken, env: {} });
  r = await s.execute(task);
  assert.equal(r.status, 'success');
  assert.equal(r.engine, 'js');
  assert.equal(r.fallback_used, true);
  assert.equal(r.tried[0].engine, 'cpp');
});

test('system: C++ galat number de to verifier pakadta hai aur JS jawab deta hai', { skip: SKIP_CPP }, async () => {
  const lying = { ...bridge, emi: a => { const r = bridge.emi(a); r.values = { ...r.values, emi: r.values.emi + 50 }; return r; } };
  const s = createEngineSystem({ cppBridge: lying, env: {} });
  const r = await s.execute(mk('loan.emi', { principal: 5000000, annual_rate: 8.5, years: 20 }));
  assert.equal(r.status, 'success');
  assert.equal(r.engine, 'js');
  assert.match(r.tried[0].reason, /VERIFY_FAILED/);
});

test('system: ghalat input => invalid_input; JS ke bina operation (C++ nahi karta) bhi JS se chalta hai', async () => {
  const s = createEngineSystem({ cppBridge: null, env: {} });
  let r = await s.execute({ operation: 'loan.emi', inputs: { principal: -5 } });
  assert.equal(r.status, 'invalid_input');
  r = await s.execute(mk('tax.gst', { amount: 1000, gst_rate: 18, inclusive: 0 }));
  assert.equal(r.status, 'success');
  assert.equal(r.engine, 'js');
});

test('remote adapter: URL ya operations na ho to null (jhootha connect nahi)', async () => {
  assert.equal(createRemoteAdapter('python', { env: {}, operations: ['invest.sip'] }), null);
  assert.equal(createRemoteAdapter('python', { env: { RY_PYTHON_URL: 'https://py.example.com' }, operations: [] }), null);
  assert.equal(createRemoteAdapter('python', { env: { RY_PYTHON_URL: 'http://insecure' }, operations: ['invest.sip'] }), null);
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => ({ result: { total_invested: 1, future_value: 2, estimated_gain: 1 }, assumptions: ['a'], engine_version: '9' }) }; };
  const a = createRemoteAdapter('python', { env: { RY_PYTHON_URL: 'https://py.example.com/' }, operations: ['invest.sip'], fetch: fakeFetch });
  assert.equal(a.capability.deployment, 'remote');
  const out = await a.run(mk('invest.sip', { monthly_amount: 1000, annual_return: 10, years: 1 }));
  assert.equal(out.engine_version, '9');
  assert.equal(calls[0][0], 'https://py.example.com/run');
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ['inputs', 'operation']);
});
