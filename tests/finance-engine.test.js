'use strict';
// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/finance-engine');

const run = (name, args) => E.runTool(name, args);
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

const emiRef = (P, rate, n) => {
  const r = rate / 1200;
  return P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
};
const sipRef = (P, rate, n) => {
  const r = rate / 1200;
  return P * ((Math.pow(1 + r, n) - 1) / r) * (1 + r);
};

/* ---------- formatINR ---------- */
test('formatINR: Indian grouping and rounding rules', () => {
  assert.equal(E.formatINR(1234567), '₹12,34,567');
  assert.equal(E.formatINR(100.4), '₹100');
  assert.equal(E.formatINR(99.5), '₹99.5');
  assert.equal(E.formatINR(-5), '-₹5');
  assert.equal(E.formatINR(0), '₹0');
  assert.throws(() => E.formatINR(NaN));
});

/* ---------- EMI ---------- */
test('EMI: standard reducing-balance', () => {
  const r = run('calc_emi', { principal: 5000000, annual_rate: 8.5, years: 20 });
  assert.ok(!r.error);
  near(r.monthly_emi_exact, emiRef(5000000, 8.5, 240));
  assert.equal(r.months, 240);
});

test('EMI: zero interest => P/n', () => {
  const r = run('calc_emi', { principal: 120000, annual_rate: 0, years: 1 });
  assert.equal(r.monthly_emi_exact, 10000);
  assert.equal(r.total_interest, '₹0');
});

test('EMI: months input works', () => {
  const r = run('calc_emi', { principal: 100000, annual_rate: 10, months: 18 });
  assert.equal(r.months, 18);
});

test('EMI: invalid inputs return error, never numbers', () => {
  assert.ok(run('calc_emi', { principal: 100000, annual_rate: 10, years: 0 }).error);
  assert.ok(run('calc_emi', { principal: 100000, annual_rate: 10 }).error);
  assert.ok(run('calc_emi', { principal: -5, annual_rate: 10, years: 5 }).error);
  assert.ok(run('calc_emi', { principal: 100000, annual_rate: -1, years: 5 }).error);
  assert.ok(run('calc_emi', { principal: 1e13, annual_rate: 10, years: 5 }).error);
  assert.ok(run('calc_emi', { principal: 100000, annual_rate: 10, years: 101 }).error);
  assert.ok(run('calc_emi', { principal: 100000, annual_rate: 'abc', years: 5 }).error);
});

/* ---------- SIP ---------- */
test('SIP: annuity-due monthly compounding', () => {
  const r = run('calc_sip', { monthly_amount: 5000, annual_return: 12, years: 10 });
  assert.equal(r.future_value, E.formatINR(sipRef(5000, 12, 120)));
  assert.equal(r.total_invested, E.formatINR(600000));
});

test('SIP: zero return => invested amount; months rounding', () => {
  assert.equal(run('calc_sip', { monthly_amount: 1000, annual_return: 0, years: 1 }).future_value, '₹12,000');
  assert.equal(run('calc_sip', { monthly_amount: 1000, annual_return: 0, years: 0.5 }).total_invested, '₹6,000');
});

test('SIP: duration shorter than one month is rejected', () => {
  assert.ok(run('calc_sip', { monthly_amount: 1000, annual_return: 10, years: 0.01 }).error);
});

/* ---------- Lumpsum / FD ---------- */
test('Lumpsum: default quarterly compounding', () => {
  const r = run('calc_lumpsum', { principal: 100000, annual_rate: 8, years: 1 });
  assert.equal(r.maturity_amount, E.formatINR(100000 * Math.pow(1.02, 4)));
  assert.equal(r.compounds_per_year, 4);
});

test('Lumpsum: custom compounding and validation', () => {
  const r = run('calc_lumpsum', { principal: 100000, annual_rate: 8, years: 2, compounds_per_year: 12 });
  assert.equal(r.maturity_amount, E.formatINR(100000 * Math.pow(1 + 0.08 / 12, 24)));
  assert.ok(run('calc_lumpsum', { principal: 1000, annual_rate: 8, years: 1, compounds_per_year: 2.5 }).error);
  assert.ok(run('calc_lumpsum', { principal: 1000, annual_rate: 8, years: 1, compounds_per_year: 0 }).error);
});

/* ---------- CAGR / simple interest / inflation ---------- */
test('CAGR', () => {
  assert.equal(run('calc_cagr', { start_value: 100, end_value: 200, years: 1 }).cagr_percent, 100);
  assert.equal(run('calc_cagr', { start_value: 100, end_value: 400, years: 2 }).cagr_percent, 100);
  assert.ok(run('calc_cagr', { start_value: 0, end_value: 400, years: 2 }).error);
});

test('Simple interest', () => {
  const r = run('calc_simple_interest', { principal: 100000, annual_rate: 10, years: 2 });
  assert.equal(r.interest, '₹20,000');
  assert.equal(r.total_amount, '₹1,20,000');
});

test('Inflation', () => {
  const r = run('calc_inflation', { current_amount: 100000, annual_inflation: 6, years: 10 });
  assert.equal(r.future_cost_estimate, E.formatINR(100000 * Math.pow(1.06, 10)));
});

/* ---------- GST ---------- */
test('GST: extra, inclusive, zero rate, invalid', () => {
  const extra = run('calc_gst', { amount: 1000, gst_rate: 18, inclusive: 0 });
  assert.equal(extra.gst_amount, '₹180');
  assert.equal(extra.total_amount, '₹1,180');

  const inc = run('calc_gst', { amount: 118, gst_rate: 18, inclusive: 1 });
  assert.equal(inc.base_amount, '₹100');
  assert.equal(inc.gst_amount, '₹18');

  const zero = run('calc_gst', { amount: 1000, gst_rate: 0, inclusive: 0 });
  assert.equal(zero.gst_amount, '₹0');
  assert.equal(zero.total_amount, '₹1,000');

  assert.ok(run('calc_gst', { amount: 100, gst_rate: 18, inclusive: 2 }).error);
  assert.ok(run('calc_gst', { amount: -100, gst_rate: 18, inclusive: 0 }).error);
});

/* ---------- comparisons ---------- */
test('compare_emi: needs an alternative; higher rate => higher EMI', () => {
  assert.ok(run('compare_emi', { principal: 1000000, annual_rate: 8, years: 10 }).error);
  const r = run('compare_emi', { principal: 1000000, annual_rate: 8, years: 10, alt_annual_rate: 9 });
  assert.equal(r.scenarios.length, 2);
  assert.equal(r.scenarios[0].label, 'base');
  assert.ok(r.scenarios[1].emi_vs_base.startsWith('+'));
});

test('compare_sip: three scenarios, ordered by return', () => {
  const r = run('compare_sip', { monthly_amount: 5000, years: 10 });
  assert.deepEqual(r.scenarios.map(s => s.label), ['conservative', 'moderate', 'high']);
  assert.equal(r.scenarios[1].future_value, E.formatINR(sipRef(5000, 10, 120)));
  assert.match(r.note, /guaranteed/);
});

/* ---------- budget ---------- */
test('budget: surplus, deficit, goal', () => {
  const b = run('calc_budget', { monthly_income: 50000, monthly_expenses: 30000 });
  assert.equal(b.monthly_surplus, '₹20,000');
  assert.equal(b.savings_rate_percent, 40);
  assert.equal(b.status, 'surplus');
  assert.equal(b.benchmark_50_30_20.savings, '₹10,000');

  assert.equal(run('calc_budget', { monthly_income: 50000, monthly_expenses: 60000 }).status, 'deficit');

  const g = run('calc_budget', { monthly_income: 50000, monthly_expenses: 30000, goal_amount: 100000 });
  assert.equal(g.goal.months_needed, 5);

  const d = run('calc_budget', { monthly_income: 50000, monthly_expenses: 60000, goal_amount: 100000 });
  assert.equal(d.goal.reachable, false);

  const done = run('calc_budget', { monthly_income: 50000, monthly_expenses: 30000, goal_amount: 1000, current_savings: 5000 });
  assert.equal(done.goal.months_needed, 0);
});

test('runTool: unknown tool', () => {
  assert.ok(run('nope', {}).error);
});

/* ---------- Hinglish / Hindi extraction ---------- */
test('extraction: lakh Hinglish EMI query', () => {
  const c = E.buildContext([{ role: 'user', content: '50 lakh ka home loan 8.5% par 20 saal ke liye EMI kitni hogi?' }]);
  assert.equal(c.intent, 'emi');
  assert.equal(c.inputs.principal, 5000000);
  assert.equal(c.inputs.annual_rate, 8.5);
  assert.equal(c.inputs.years, 20);
  assert.ok(c.complete);
});

test('extraction: 50L and ₹50,00,000 formats', () => {
  const a = E.buildContext([{ role: 'user', content: 'EMI 50L 8.5% 20 saal' }]);
  assert.equal(a.inputs.principal, 5000000);
  const b = E.buildContext([{ role: 'user', content: 'EMI ₹50,00,000 8.5% 20 saal' }]);
  assert.equal(b.inputs.principal, 5000000);
});

test('extraction: Devanagari digits', () => {
  const c = E.buildContext([{ role: 'user', content: 'EMI 50 lakh 8.5% ५ साल' }]);
  assert.equal(c.inputs.years, 5);
});

test('extraction: ambiguous amounts ask for clarification', () => {
  const c = E.buildContext([{ role: 'user', content: 'EMI 5 lakh 8 lakh 9% 5 saal' }]);
  assert.equal(c.ambiguous.length, 1);
  assert.equal(c.complete, false);
});

test('extraction: missing inputs are reported', () => {
  const c = E.buildContext([{ role: 'user', content: 'home loan 8.5% 20 saal' }]);
  assert.ok(c.missing.includes('principal'));
  assert.equal(c.complete, false);
});

test('context: follow-up changes only tenure', () => {
  const c = E.buildContext([
    { role: 'user', content: '50 lakh ka home loan 8.5% par 10 saal ke liye EMI?' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'ab 15 saal kar do' }
  ]);
  assert.equal(c.inputs.years, 15);
  assert.equal(c.inputs.principal, 5000000);
  assert.ok(c.fresh && c.complete);
});

test('context: compare intent from two rates', () => {
  const c = E.buildContext([{ role: 'user', content: 'EMI compare 8% vs 9% 50 lakh 20 saal' }]);
  assert.equal(c.tool, 'compare_emi');
  assert.equal(c.inputs.annual_rate, 8);
  assert.equal(c.inputs.alt_annual_rate, 9);
  assert.ok(c.complete);
});

/* ---------- intents ---------- */
test('intent detection', () => {
  assert.equal(E.detectFinanceIntent('repo rate kya hai'), 'rates_rules');
  assert.equal(E.detectFinanceIntent('income tax kaise bachaye'), 'tax');
  assert.equal(E.detectFinanceIntent('SIP kya hai'), 'sip');
  assert.equal(E.detectFinanceIntent('namaste'), 'general');
});

/* ---------- reply verification ---------- */
test('verifyReply: catches fabricated amounts, accepts tool numbers', () => {
  const args = { principal: 500000, annual_rate: 9, years: 5 };
  const result = run('calc_emi', args);
  const calls = [{ name: 'calc_emi', args, result }];

  assert.equal(E.verifyReply('Aapki EMI ' + result.monthly_emi + ' hogi.', calls, [], null).ok, true);

  const bad = E.verifyReply('Aapki EMI ₹99,999 hogi.', calls, [], null);
  assert.equal(bad.ok, false);
  assert.ok(bad.unknown.length);
});

/* ---------- trusted domains ---------- */
test('trustedDomain: exact/subdomain only', () => {
  assert.equal(E.trustedDomain({ uri: 'https://www.rbi.org.in/page' }), 'rbi.org.in');
  assert.equal(E.trustedDomain({ title: 'incometax.gov.in' }), 'incometax.gov.in');
  assert.equal(E.trustedDomain({ uri: 'https://rbi.org.in.evil.com/x' }), null);
  assert.equal(E.trustedDomain(null), null);
});

test('describeResult: errors never invent numbers', () => {
  const t = E.describeResult('calc_emi', {}, { error: 'principal missing hai' });
  assert.match(t, /nahi ho paya/);
});

/* ---------- regression: bugs jo review mein mile ---------- */
test('intent: "kharcha" jaisa generic shabd specific calculator ko nahi rokta', () => {
  const c = E.buildContext([{ role: 'user', content: 'aaj 50000 ka kharcha 6% mehngai par 10 saal baad?' }]);
  assert.equal(c.intent, 'inflation');
  assert.deepEqual(c.inputs, { current_amount: 50000, annual_inflation: 6, years: 10 });
  assert.ok(c.complete);
});

test('verifyReply: saal/mahine ka seedha gunaa-bhaag jaayaz hai (EMI x 12)', () => {
  const args = { principal: 5000000, annual_rate: 8.5, years: 20 };
  const calls = [{ name: 'calc_emi', args, result: run('calc_emi', args) }];
  const r = E.verifyReply('EMI ₹43,391 hai, yaani saal ka lagbhag ₹5,20,694.', calls, ['50 lakh'], null);
  assert.equal(r.ok, true);
});

test('verifyReply: percent check optional (salah wale % galat flag na hon)', () => {
  const args = { principal: 5000000, annual_rate: 8.5, years: 20 };
  const calls = [{ name: 'calc_emi', args, result: run('calc_emi', args) }];
  const text = 'EMI ₹43,391 hai. EMI income ke 40% se zyada nahi honi chahiye.';
  assert.equal(E.verifyReply(text, calls, ['50 lakh'], null).ok, false);
  assert.equal(E.verifyReply(text, calls, ['50 lakh'], null, [], { rates: false }).ok, true);
});

test('verifyReply: model ne kami wala input khud guess kiya to mismatch', () => {
  const msgs = [{ role: 'user', content: '50 lakh ka home loan 20 saal EMI' }];
  const ctx = E.buildContext(msgs);
  assert.equal(ctx.complete, false);
  const args = { principal: 5000000, annual_rate: 9, years: 20 };
  const calls = [{ name: 'calc_emi', args, result: run('calc_emi', args) }];
  const r = E.verifyReply('EMI ' + calls[0].result.monthly_emi + ' hogi.', calls, [msgs[0].content], ctx);
  assert.equal(r.ok, false);
  assert.match(r.mismatch[0], /annual_rate/);
});

test('verifyReply: model ne galat amount se tool chalaya to mismatch', () => {
  const msgs = [{ role: 'user', content: '50 lakh ka home loan 8.5% par 20 saal EMI' }];
  const ctx = E.buildContext(msgs);
  const args = { principal: 50000, annual_rate: 8.5, years: 20 };
  const calls = [{ name: 'calc_emi', args, result: run('calc_emi', args) }];
  assert.equal(E.verifyReply('EMI ' + calls[0].result.monthly_emi, calls, [msgs[0].content], ctx).ok, false);
});
