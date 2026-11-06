'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('../lib/contracts');
const { createRegistry } = require('../lib/engine-registry');
const { createHealth } = require('../lib/engine-health');
const { route } = require('../lib/engine-router');
const { createController } = require('../lib/engine-controller');

const cap = (name, technology, extra = {}) => ({
  name, technology, version: '1.0.0', contract_version: '1.0', operations: ['loan.emi'],
  typical_latency_ms: 5, max_job_size: 1000, cost_class: 'cheap', deployment: 'in-process', ...extra
});
const good = () => ({ result: { monthly_emi: 43391.16 }, assumptions: ['monthly compounding'] });
const adapter = (name, technology, run, extra) => ({ capability: cap(name, technology, extra), run });
const taskIn = (o = {}) => contracts.createTask({ operation: 'loan.emi', inputs: { principal: 5000000, annual_rate: 8.5, years: 20 }, timeout_ms: 1000, ...o });
const task = (o) => { const t = taskIn(o); assert.equal(t.ok, true, JSON.stringify(t.errors)); return t.task; };

function setup(adapters, hopts, copts) {
  const registry = createRegistry();
  adapters.forEach(a => registry.register(a));
  const health = createHealth(hopts);
  return { registry, health, ctl: createController({ registry, health, ...copts }) };
}

test('registry: galat adapter aur duplicate naam refuse', () => {
  const r = createRegistry();
  assert.throws(() => r.register({}));
  assert.throws(() => r.register({ capability: { name: 'x' }, run() {} }));
  r.register(adapter('js-a', 'js', good));
  assert.throws(() => r.register(adapter('js-a', 'js', good)));
  assert.equal(r.size(), 1);
});

test('router: order fixed (cpp pehle, js baad) aur hamesha same', () => {
  const { registry, health } = setup([adapter('js-a', 'js', good), adapter('cpp-a', 'cpp', good)]);
  const t = task();
  const a = route(t, { registry, health }).candidates.map(c => c.name);
  const b = route(t, { registry, health }).candidates.map(c => c.name);
  assert.deepEqual(a, ['cpp-a', 'js-a']);
  assert.deepEqual(a, b);
});

test('router: job size se bade engine hat jaate hain', () => {
  const { registry, health } = setup([adapter('js-a', 'js', good), adapter('cpp-a', 'cpp', good, { max_job_size: 5 })]);
  const p = route(task(), { registry, health, jobSize: 50 });
  assert.deepEqual(p.candidates.map(c => c.name), ['js-a']);
  assert.equal(p.dropped[0].engine, 'cpp-a');
});

test('success: engine, version, route_reason aur envelope sahi', async () => {
  const { ctl } = setup([adapter('js-a', 'js', good)]);
  const r = await ctl.execute(task());
  assert.equal(r.status, 'success');
  assert.equal(r.engine, 'js');
  assert.equal(r.fallback_used, false);
  assert.ok(r.route_reason);
  assert.equal(contracts.validateResultFor('loan.emi', r).ok, true);
});

test('invalid task => invalid_input, engine nahi chalta', async () => {
  let called = 0;
  const { ctl } = setup([adapter('js-a', 'js', () => { called++; return good(); })]);
  const r = await ctl.execute({ operation: 'loan.emi', inputs: {} });
  assert.equal(r.status, 'invalid_input');
  assert.equal(r.result, null);
  assert.equal(called, 0);
});

test('koi engine nahi => unavailable NO_ENGINE', async () => {
  const { ctl } = setup([]);
  const r = await ctl.execute(task());
  assert.equal(r.status, 'unavailable');
  assert.equal(r.error.code, 'NO_ENGINE');
  assert.equal(r.result, null);
});

test('engine fail => agla engine, fallback_used true', async () => {
  const boom = () => { throw new Error('engine toot gaya'); };
  const { ctl } = setup([adapter('cpp-a', 'cpp', boom), adapter('js-a', 'js', good)]);
  const r = await ctl.execute(task());
  assert.equal(r.status, 'success');
  assert.equal(r.engine, 'js');
  assert.equal(r.fallback_used, true);
  assert.equal(r.tried[0].engine, 'cpp');
});

test('sab fail => unavailable, result null', async () => {
  const boom = () => { throw new Error('toota'); };
  const { ctl } = setup([adapter('cpp-a', 'cpp', boom), adapter('js-a', 'js', boom)]);
  const r = await ctl.execute(task());
  assert.equal(r.status, 'unavailable');
  assert.equal(r.result, null);
  assert.equal(r.tried.length, 2);
});

test('NaN result reject (CONTRACT_BREACH) aur agla engine', async () => {
  const bad = () => ({ result: { monthly_emi: NaN }, assumptions: ['x'] });
  const { ctl } = setup([adapter('cpp-a', 'cpp', bad), adapter('js-a', 'js', good)]);
  const r = await ctl.execute(task());
  assert.equal(r.engine, 'js');
  assert.match(r.tried[0].reason, /CONTRACT_BREACH/);
});

test('assumptions ke bina jawab reject', async () => {
  const bad = () => ({ result: { monthly_emi: 1 }, assumptions: [] });
  const { ctl } = setup([adapter('js-a', 'js', bad)]);
  const r = await ctl.execute(task());
  assert.notEqual(r.status, 'success');
});

test('engine ka validation error => invalid_input, fallback nahi', async () => {
  let second = 0;
  const reject = () => { const e = new Error('invalid input: rate'); e.name = 'ValidationError'; throw e; };
  const { ctl } = setup([adapter('cpp-a', 'cpp', reject), adapter('js-a', 'js', () => { second++; return good(); })]);
  const r = await ctl.execute(task());
  assert.equal(r.status, 'invalid_input');
  assert.equal(second, 0);
});

test('verifier fail => agla engine; sab fail => failed_verification', async () => {
  const verifier = async (t, env) => (env.engine === 'js' ? { ok: true, method: 'alt' } : { ok: false, message: 'mismatch' });
  let s = setup([adapter('cpp-a', 'cpp', good), adapter('js-a', 'js', good)], {}, { verifier });
  let r = await s.ctl.execute(task());
  assert.equal(r.status, 'success');
  assert.equal(r.engine, 'js');
  assert.equal(r.fallback_used, true);
  assert.equal(r.verified, true);
  s = setup([adapter('js-a', 'js', good)], {}, { verifier: async () => ({ ok: false, message: 'nahi mila' }) });
  r = await s.ctl.execute(task());
  assert.equal(r.status, 'failed_verification');
  assert.equal(r.result, null);
});

test('circuit: 3 fail ke baad pause, 30s baad dobara', async () => {
  let t = 1000;
  const now = () => t;
  let fails = true;
  const flaky = () => { if (fails) throw new Error('toota'); return good(); };
  const { ctl, health } = setup([adapter('js-a', 'js', flaky)], { now }, { now });
  for (let i = 0; i < 3; i++) await ctl.execute(task());
  assert.equal(health.isOpen('js-a'), true);
  let r = await ctl.execute(task());
  assert.equal(r.error.code, 'NO_ENGINE');
  t += 31000;
  fails = false;
  assert.equal(health.isOpen('js-a'), false);
  r = await ctl.execute(task());
  assert.equal(r.status, 'success');
  assert.equal(health.snapshot('js-a').status, 'ok');
});

test('transient network error par usi engine ko ek baar retry', async () => {
  let n = 0;
  const flaky = () => { n++; if (n === 1) { const e = new Error('fetch failed'); e.code = 'ECONNRESET'; throw e; } return good(); };
  const { ctl } = setup([adapter('js-a', 'js', flaky)]);
  const r = await ctl.execute(task());
  assert.equal(r.status, 'success');
  assert.equal(n, 2);
});

test('dhimi par waqt ke andar wala engine chalta hai', async () => {
  const slow = () => new Promise(res => setTimeout(() => res(good()), 400));
  const { ctl } = setup([adapter('cpp-a', 'cpp', slow), adapter('js-a', 'js', good)]);
  const r = await ctl.execute(task({ timeout_ms: 1000 }));
  assert.equal(r.status, 'success');
  assert.equal(r.engine, 'cpp'); // 400ms < 1000ms: dhimi hai par waqt ke andar
});

test('sab timeout => status timeout', async () => {
  const hang = () => new Promise(() => {});
  const { ctl } = setup([adapter('js-a', 'js', hang)]);
  const r = await ctl.execute(task({ timeout_ms: 1000 }));
  assert.equal(r.status, 'timeout');
  assert.equal(r.result, null);
});
