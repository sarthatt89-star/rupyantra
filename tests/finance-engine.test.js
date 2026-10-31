'use strict';

/*
 * Known-answer tests for lib/finance-engine.js
 * Expected values were computed independently (plain loops / textbook formulas),
 * not by calling the engine. Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../lib/finance-engine');
const validator = require('../lib/finance-validator');

// "₹43,391" -> 43391 ; "-₹5,000" -> -5000
const inr = s => {
  const neg = /^\s*-/.test(String(s));
  const n = Number(String(s).replace(/[₹,\s+-]/g, ''));
  return neg ? -n : n;
};

const near = (got, want, tol, label) =>
  assert.ok(Math.abs(got - want) <= tol, `${label}: got ${got}, want ${want} (tol ${tol})`);

const run = (tool, args) => engine.runTool(tool, args);

/* ---------- EMI ---------- */

test('EMI: 50 lakh, 8.5%, 20 saal', () => {
  const r = run('calc_emi', { principal: 5000000, annual_rate: 8.5, years: 20 });
  near(inr(r.monthly_emi), 43391, 1, 'emi');
  near(inr(r.total_payment), 10413879, 2, 'total_payment');
  near(inr(r.total_interest), 5413879, 2, 'total_interest');
  assert.equal(r.months, 240);
});

test('EMI: 10 lakh, 10%, 60 mahine (months input)', () => {
  const r = run('calc_emi', { principal: 1000000, annual_rate: 10, months: 60 });
  near(inr(r.monthly_emi), 21247, 1, 'emi');
  near(inr(r.total_interest), 274823, 2, 'interest');
});

test('EMI: zero rate => principal / months', () => {
  const r = run('calc_emi', { principal: 120000, annual_rate: 0, years: 1 });
  near(inr(r.monthly_emi), 10000, 0.01, 'emi');
});

test('EMI: string inputs with commas and rupee sign are accepted', () => {
  const r = run('calc_emi', { principal: '₹50,00,000', annual_rate: '8.5', years: '20' });
  near(inr(r.monthly_emi), 43391, 1, 'emi');
});

/* ---------- SIP ---------- */

test('SIP: 10,000/month, 12%, 10 saal (deposit at start of month)', () => {
  const r = run('calc_sip', { monthly_amount: 10000, annual_return: 12, years: 10 });
  near(inr(r.total_invested), 1200000, 0.5, 'invested');
  near(inr(r.future_value), 2323391, 1, 'future_value');
  near(inr(r.estimated_gain), 1123391, 2, 'gain');
});

test('SIP: zero return => future value equals invested', () => {
  const r = run('calc_sip', { monthly_amount: 5000, annual_return: 0, years: 2 });
  near(inr(r.future_value), 120000, 0.5, 'future_value');
});

/* ---------- FD / lumpsum ---------- */

test('Lumpsum: 1 lakh, 7%, 5 saal, quarterly (default)', () => {
  const r = run('calc_lumpsum', { principal: 100000, annual_rate: 7, years: 5 });
  near(inr(r.maturity_amount), 141478, 1, 'maturity');
  near(inr(r.interest_earned), 41478, 1, 'interest');
  assert.equal(r.compounds_per_year, 4);
});

test('Lumpsum: monthly compounding', () => {
  const r = run('calc_lumpsum', { principal: 100000, annual_rate: 8, years: 3, compounds_per_year: 12 });
  near(inr(r.maturity_amount), 127024, 1, 'maturity');
});

/* ---------- CAGR / simple interest / inflation / GST / budget ---------- */

test('CAGR: 1 lakh -> 2 lakh in 5 saal', () => {
  const r = run('calc_cagr', { start_value: 100000, end_value: 200000, years: 5 });
  near(r.cagr_percent, 14.87, 0.006, 'cagr');
});

test('Simple interest: 1 lakh, 8%, 3 saal', () => {
  const r = run('calc_simple_interest', { principal: 100000, annual_rate: 8, years: 3 });
  near(inr(r.interest), 24000, 0.5, 'interest');
  near(inr(r.total_amount), 124000, 0.5, 'total');
});

test('Inflation: 1 lakh, 6%, 10 saal', () => {
  const r = run('calc_inflation', { current_amount: 100000, annual_inflation: 6, years: 10 });
  near(inr(r.future_cost_estimate), 179085, 1, 'future');
});

test('GST: 1000 + 18% extra', () => {
  const r = run('calc_gst', { amount: 1000, gst_rate: 18, inclusive: 0 });
  near(inr(r.gst_amount), 180, 0.5, 'gst');
  near(inr(r.total_amount), 1180, 0.5, 'total');
});

test('GST: 1180 inclusive of 18%', () => {
  const r = run('calc_gst', { amount: 1180, gst_rate: 18, inclusive: 1 });
  near(inr(r.base_amount), 1000, 0.5, 'base');
  near(inr(r.gst_amount), 180, 0.5, 'gst');
});

test('Budget: income 50,000, expenses 30,000', () => {
  const r = run('calc_budget', { monthly_income: 50000, monthly_expenses: 30000 });
  near(inr(r.monthly_surplus), 20000, 0.5, 'surplus');
  near(r.savings_rate_percent, 40, 0.01, 'savings rate');
  assert.equal(r.status, 'surplus');
});

/* ---------- compare tools ---------- */

test('compare_emi: base + alt rate gives 2 scenarios', () => {
  const r = run('compare_emi', { principal: 5000000, annual_rate: 8.5, years: 20, alt_annual_rate: 9.5 });
  assert.equal(r.scenarios.length, 2);
  near(inr(r.scenarios[0].monthly_emi), 43391, 1, 'base emi');
  assert.ok(inr(r.scenarios[1].monthly_emi) > inr(r.scenarios[0].monthly_emi));
});

test('compare_sip: 3 scenarios, higher return => higher value', () => {
  const r = run('compare_sip', { monthly_amount: 10000, years: 10 });
  assert.equal(r.scenarios.length, 3);
  const fv = r.scenarios.map(s => inr(s.future_value));
  assert.ok(fv[0] < fv[1] && fv[1] < fv[2]);
});

/* ---------- bad inputs must return {error}, never throw or NaN ---------- */

test('Bad inputs return an error object', () => {
  for (const [tool, args] of [
    ['calc_emi', { principal: -5, annual_rate: 8, years: 5 }],
    ['calc_emi', { principal: 100000, annual_rate: 8 }],
    ['calc_emi', { principal: 100000, annual_rate: 500, years: 5 }],
    ['calc_sip', { monthly_amount: 1000, annual_return: 10, years: 0 }],
    ['calc_gst', { amount: 100, gst_rate: 18, inclusive: 5 }],
    ['compare_emi', { principal: 100000, annual_rate: 8, years: 5 }],
    ['no_such_tool', {}]
  ]) {
    const r = run(tool, args);
    assert.ok(r && r.error, `${tool} should return error for ${JSON.stringify(args)}`);
  }
});

/* ---------- validator independently agrees with the engine ---------- */

test('validator.verifyCalculation passes for engine results', () => {
  const cases = [
    ['calc_emi', { principal: 5000000, annual_rate: 8.5, years: 20 }],
    ['calc_sip', { monthly_amount: 10000, annual_return: 12, years: 10 }],
    ['calc_lumpsum', { principal: 100000, annual_rate: 7, years: 5 }],
    ['calc_cagr', { start_value: 100000, end_value: 200000, years: 5 }],
    ['calc_simple_interest', { principal: 100000, annual_rate: 8, years: 3 }],
    ['calc_inflation', { current_amount: 100000, annual_inflation: 6, years: 10 }],
    ['calc_budget', { monthly_income: 50000, monthly_expenses: 30000 }]
  ];
  for (const [tool, args] of cases) {
    const v = validator.verifyCalculation(tool, args, run(tool, args));
    assert.ok(v.ok, `${tool}: ${JSON.stringify(v.errors)}`);
  }
});

/* ---------- Hinglish text -> inputs ---------- */

test('buildContext: "50 lakh ka loan 8.5% par 20 saal ki EMI"', () => {
  const ctx = engine.buildContext([{ role: 'user', content: '50 lakh ka loan 8.5% par 20 saal ki EMI batao' }]);
  assert.equal(ctx.tool, 'calc_emi');
  assert.equal(ctx.complete, true);
  assert.equal(ctx.inputs.principal, 5000000);
  assert.equal(ctx.inputs.annual_rate, 8.5);
  assert.equal(ctx.inputs.years, 20);
});

test('buildContext: follow-up "ab 15 saal kar do" changes only the tenure', () => {
  const ctx = engine.buildContext([
    { role: 'user', content: '50 lakh loan 8.5% 20 saal EMI' },
    { role: 'assistant', content: 'EMI nikal di.' },
    { role: 'user', content: 'ab 15 saal kar do' }
  ]);
  assert.equal(ctx.inputs.principal, 5000000);
  assert.equal(ctx.inputs.years, 15);
});
