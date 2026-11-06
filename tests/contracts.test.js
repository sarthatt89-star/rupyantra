'use strict';

// Phase 1: contracts (lib/contracts.js). Koi engine, network ya api/chat.js nahi chalta.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/contracts');
const engine = require('../lib/finance-engine');

const GOLDEN = { principal: 5000000, annual_rate: 8.5, years: 20 };
const mk = (over = {}) => C.createTask({ operation: 'loan.emi', inputs: GOLDEN, ...over });
const fields = r => r.errors.map(e => e.field);

/* ---------- operations registry, JS engine ke saath milta hai ---------- */

test('registry: har operation ka js_tool asli engine mein hai, aur input naam tools ke params se milte hain', () => {
  const tools = Object.fromEntries(engine.TOOLS.map(t => [t.name, t]));
  for (const [name, op] of Object.entries(C.OPERATIONS)) {
    const tool = tools[op.js_tool];
    assert.ok(tool, name + ' ka tool ' + op.js_tool + ' engine mein nahi');
    assert.deepEqual(Object.keys(op.inputs).sort(), Object.keys(tool.params).sort(), name + ' ke input naam tool se alag hain');
    for (const req of tool.required) {
      const spec = op.inputs[req];
      assert.ok(spec && (spec.required || (op.oneOf || []).flat().includes(req)), name + ': ' + req + ' zaroori hona chahiye');
    }
  }
});

test('registry: operation ka naam domain.naam hai aur domain sahi hai', () => {
  for (const [name, op] of Object.entries(C.OPERATIONS)) {
    assert.ok(/^[a-z]+\.[a-z_]+$/.test(name));
    assert.equal(name.split('.')[0], op.domain);
    for (const spec of Object.values(op.inputs)) assert.ok(C.UNITS[spec.unit], 'unit known hona chahiye');
  }
});

/* ---------- task ---------- */

test('task: golden loan ka sahi task pass hota hai, defaults lagte hain', () => {
  const r = mk();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.task.contract_version, '1.0');
  assert.equal(r.task.verify, true);
  assert.equal(r.task.timeout_ms, 5000);
  assert.deepEqual(r.task.depends_on, []);
  assert.deepEqual(r.task.units, { principal: 'inr', annual_rate: 'percent', years: 'years' });
  assert.equal(r.task.engine_preference, null);
});

test('task: "₹50,00,000" jaise text number ban jaate hain', () => {
  const r = mk({ inputs: { principal: '₹50,00,000', annual_rate: '8.5', years: '20' } });
  assert.equal(r.ok, true);
  assert.equal(r.task.inputs.principal, 5000000);
});

test('task: months se bhi chalta hai; na years na months to refuse', () => {
  assert.equal(mk({ inputs: { principal: 100000, annual_rate: 9, months: 36 } }).ok, true);
  const bad = mk({ inputs: { principal: 100000, annual_rate: 9 } });
  assert.equal(bad.ok, false);
  assert.ok(fields(bad).includes('years/months'));
});

test('task: zaroori input kam ho to saaf batata hai', () => {
  const r = mk({ inputs: { principal: 100000 } });
  assert.equal(r.ok, false);
  assert.ok(fields(r).includes('annual_rate'));
});

test('task: negative, zero principal, rate 101, years 101 sab refuse', () => {
  for (const inputs of [
    { ...GOLDEN, principal: -1 }, { ...GOLDEN, principal: 0 }, { ...GOLDEN, annual_rate: 101 },
    { ...GOLDEN, annual_rate: -0.1 }, { ...GOLDEN, years: 101 }, { ...GOLDEN, principal: 2e12 }
  ]) assert.equal(mk({ inputs }).ok, false, JSON.stringify(inputs));
});

test('task: zero interest rate allowed hai (edge case)', () => {
  assert.equal(mk({ inputs: { ...GOLDEN, annual_rate: 0 } }).ok, true);
});

test('task: NaN, Infinity, text, object input refuse', () => {
  for (const v of [NaN, Infinity, 'abc', {}, [], '1e5x']) {
    assert.equal(mk({ inputs: { ...GOLDEN, principal: v } }).ok, false, String(v));
  }
});

test('task: anjaan input chupke se nahi nigla jaata', () => {
  const r = mk({ inputs: { ...GOLDEN, bonus: 5 } });
  assert.equal(r.ok, false);
  assert.ok(fields(r).includes('bonus'));
});

test('task: personal pehchaan wale input refuse (PAN, Aadhaar, account, card, OTP, password, phone, email)', () => {
  for (const key of ['pan', 'aadhaar', 'account_number', 'card_number', 'otp', 'password', 'phone', 'email', 'upi_id', 'ifsc']) {
    const r = mk({ inputs: { ...GOLDEN, [key]: '123' } });
    assert.equal(r.ok, false, key);
    assert.ok(fields(r).includes(key), key);
  }
});

test('task: galat operation, galat domain, galat id, galat timeout', () => {
  assert.equal(mk({ operation: 'loan.nothing' }).ok, false);
  assert.equal(mk({ operation: 'LOAN-EMI' }).ok, false);
  assert.equal(mk({ domain: 'invest' }).ok, false);
  assert.equal(mk({ request_id: 'x' }).ok, false);
  assert.equal(mk({ task_id: 'bad id with spaces' }).ok, false);
  for (const t of [50, 30001, 1.5, 'fast']) assert.equal(mk({ timeout_ms: t }).ok, false, String(t));
  assert.equal(mk({ timeout_ms: 2000 }).ok, true);
});

test('task: engine_preference sirf hint hai aur known engine hona chahiye', () => {
  assert.equal(mk({ engine_preference: 'cpp' }).ok, true);
  assert.equal(mk({ engine_preference: 'java' }).ok, false);
});

test('task: depends_on list ki jaanch, aur apne par depend nahi', () => {
  assert.equal(mk({ depends_on: ['task_aaaaaa'] }).ok, true);
  assert.equal(mk({ depends_on: 'task_aaaaaa' }).ok, false);
  assert.equal(mk({ task_id: 'task_self01', depends_on: ['task_self01'] }).ok, false);
});

test('task: naya major version refuse, same major chalta hai', () => {
  assert.equal(C.validateTask({ ...mk().task, contract_version: '2.0' }).ok, false);
  assert.equal(C.validateTask({ ...mk().task, contract_version: '1.7' }).ok, true);
});

test('task: input badalne par original object nahi badalta', () => {
  const inputs = { ...GOLDEN, principal: '₹50,00,000' };
  const snapshot = JSON.stringify(inputs);
  mk({ inputs });
  assert.equal(JSON.stringify(inputs), snapshot);
});

test('task: har operation ka ek chhota sahi task bana sakte hain', () => {
  const samples = {
    'loan.emi': GOLDEN,
    'loan.compare_emi': { principal: 1e6, annual_rate: 9, years: 10, alt_annual_rate: 8, alt_years: 12 },
    'invest.sip': { monthly_amount: 10000, annual_return: 12, years: 10 },
    'invest.compare_sip': { monthly_amount: 5000, years: 15 },
    'invest.lumpsum': { principal: 100000, annual_rate: 8, years: 5, compounds_per_year: 4 },
    'invest.cagr': { start_value: 100000, end_value: 200000, years: 5 },
    'interest.simple': { principal: 100000, annual_rate: 8, years: 3 },
    'tax.gst': { amount: 1000, gst_rate: 18, inclusive: false },
    'inflation.future_cost': { current_amount: 100000, annual_inflation: 6, years: 10 },
    'budget.summary': { monthly_income: 50000, monthly_expenses: 30000 }
  };
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(C.OPERATIONS).sort(), 'har operation ka sample hona chahiye');
  for (const [operation, inputs] of Object.entries(samples)) {
    const r = C.createTask({ operation, inputs });
    assert.equal(r.ok, true, operation + ' ' + JSON.stringify(r.errors));
    // aur wahi inputs asli JS engine me bhi chalte hain (contract engine se alag nahi)
    const res = engine.runTool(C.OPERATIONS[operation].js_tool, inputs);
    assert.ok(!res.error, operation + ' engine me fail: ' + res.error);
  }
});

/* ---------- result ---------- */

const goodFields = () => ({
  result: { monthly_emi: 43391.16 },
  assumptions: ['reducing balance, monthly compounding'],
  engine: 'js', engine_version: '1.0.0', route_reason: 'sirf JS ye operation deta hai', duration_ms: 2
});
const task = () => mk().task;

test('result: poora sahi success envelope pass hota hai', () => {
  const env = C.createResult(task(), goodFields());
  const v = C.validateResultFor('loan.emi', env);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(env.inputs, task().inputs);
  assert.equal(env.error, null);
});

test('result: engine, version, assumptions, route_reason ke bina success refuse', () => {
  for (const drop of ['engine', 'engine_version', 'assumptions', 'route_reason']) {
    const f = goodFields();
    delete f[drop];
    assert.equal(C.validateResult(C.createResult(task(), f)).ok, false, drop);
  }
});

test('result: NaN / Infinity / "NaN" text wala result success nahi ban sakta', () => {
  for (const bad of [{ a: NaN }, { a: Infinity }, { a: { b: ['₹NaN'] } }, { a: 'undefined' }]) {
    assert.equal(C.validateResult(C.createResult(task(), { ...goodFields(), result: bad })).ok, false, JSON.stringify(bad));
  }
});

test('result: fail status mein result null aur error {code,message} zaroori', () => {
  for (const status of ['invalid_input', 'failed_verification', 'unavailable', 'timeout']) {
    const ok = C.createResult(task(), { status, error: { code: 'X', message: 'wajah' }, result: { leaked: 1 } });
    assert.equal(ok.result, null, 'fail me adhura number nahi jaata');
    assert.equal(C.validateResult(ok).ok, true, status);
    assert.equal(C.validateResult(C.createResult(task(), { status })).ok, false, status + ' bina error ke');
  }
  const forged = { ...C.createResult(task(), { status: 'timeout', error: { code: 'T', message: 'der' } }), result: { monthly_emi: 1 } };
  assert.equal(C.validateResult(forged).ok, false);
});

test('result: anjaan status refuse', () => {
  assert.equal(C.validateResult({ ...C.createResult(task(), goodFields()), status: 'maybe' }).ok, false);
});

test('result: fallback tabhi sahi jab pehle koi aur engine try hokar fail hua', () => {
  const noTried = C.createResult(task(), { ...goodFields(), fallback_used: true });
  assert.equal(C.validateResult(noTried).ok, false);
  const same = C.createResult(task(), { ...goodFields(), fallback_used: true, tried: [{ engine: 'js', reason: 'x' }] });
  assert.equal(C.validateResult(same).ok, false);
  const ok = C.createResult(task(), { ...goodFields(), fallback_used: true, tried: [{ engine: 'cpp', reason: 'timeout' }] });
  assert.equal(C.validateResult(ok).ok, true);
});

test('result: projection operations mein guaranteed:false zaroori', () => {
  const sip = C.createTask({ operation: 'invest.sip', inputs: { monthly_amount: 10000, annual_return: 12, years: 10 } }).task;
  const env = C.createResult(sip, { ...goodFields(), result: { future_value: 2323391 }, assumptions: ['assumed return 12%, guaranteed nahi'] });
  assert.equal(env.guaranteed, false);
  assert.equal(C.validateResultFor('invest.sip', env).ok, true);
  const lying = { ...env };
  delete lying.guaranteed;
  assert.equal(C.validateResultFor('invest.sip', lying).ok, false);
  assert.equal(C.validateResultFor('invest.sip', { ...env, guaranteed: true }).ok, false);
  // EMI projection nahi hai, guaranteed ki shart nahi
  assert.equal(C.createResult(task(), goodFields()).guaranteed, undefined);
});

test('result: object nahi to refuse', () => {
  for (const x of [null, undefined, 5, 'x', []]) assert.equal(C.validateResult(x).ok, false);
});

/* ---------- capability ---------- */

const cap = () => ({
  name: 'js-reference', technology: 'js', version: '1.0.0', contract_version: '1.0',
  operations: ['loan.emi', 'invest.sip'], typical_latency_ms: 1, max_job_size: 1,
  cost_class: 'cheap', deployment: 'in-process'
});

test('capability: sahi record pass, galat fields refuse', () => {
  assert.equal(C.validateCapability(cap()).ok, true);
  const bad = [
    { technology: 'java' }, { version: '' }, { contract_version: '2.0' }, { operations: [] }, { operations: ['loan.magic'] },
    { typical_latency_ms: -1 }, { max_job_size: 0 }, { cost_class: 'free' }, { deployment: 'cloud' }, { name: 'X Y' }
  ];
  for (const over of bad) assert.equal(C.validateCapability({ ...cap(), ...over }).ok, false, JSON.stringify(over));
});

/* ---------- tolerance ---------- */

test('tolerance: paise Rs 1 ke andar, percent 0.01 ke andar, months bilkul barabar', () => {
  assert.equal(C.withinTolerance(43391.16, 43391.9, 'inr'), true);
  assert.equal(C.withinTolerance(43391.16, 43392.5, 'inr'), false);
  assert.equal(C.withinTolerance(14.87, 14.875, 'percent'), true);
  assert.equal(C.withinTolerance(14.87, 14.9, 'percent'), false);
  assert.equal(C.withinTolerance(240, 240, 'months'), true);
  assert.equal(C.withinTolerance(240, 241, 'months'), false);
  assert.equal(C.withinTolerance(NaN, 1, 'inr'), false);
});

test('tolerance: golden EMI JS engine se (43,391.16) Rs 1 ke andar milti hai', () => {
  const res = engine.runTool('calc_emi', GOLDEN);
  assert.equal(C.withinTolerance(res.monthly_emi_exact, 43391.16, 'inr'), true);
});

test('parseNumber', () => {
  assert.equal(C.parseNumber('₹1,23,456.50'), 123456.5);
  assert.equal(C.parseNumber(' 7 '), 7);
  assert.equal(C.parseNumber(true), 1);
  assert.ok(Number.isNaN(C.parseNumber('')));
  assert.ok(Number.isNaN(C.parseNumber(null)));
  assert.ok(Number.isNaN(C.parseNumber('1,2,x')));
});
