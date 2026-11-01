'use strict';

/*
 * The C++ tools as the chat sees them (lib/cpp-tools.js + lib/cpp-integration.js).
 * These tests need no WebAssembly file: tools with a JS fallback run on it, and the simulation tools run on a
 * small stand-in bridge so their wiring and the independent checks can be tested.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../lib/finance-engine');
const validator = require('../lib/finance-validator');
const router = require('../lib/intent-router');
const tools = require('../lib/cpp-tools');
const integration = require('../lib/cpp-integration');
const realBridge = require('../lib/cpp-bridge');

const inr = tools.parseINR;
const runChecked = (name, args) => {
  const result = tools.TOOLS.find(t => t.name === name).run(args);
  return { result, check: tools.verifyCalculation(name, args, result) };
};

/* stand-in bridge: exact when volatility is 0, otherwise a fixed symmetric spread; everything else uses the real bridge */
const standIn = Object.assign({}, realBridge, {
  simulateSip(a) {
    const n = Math.round(a.years * 12);
    const det = tools.jsSipFv(a.monthly_amount, a.annual_return, n);
    const k = a.annual_volatility / 100;
    return { ok: true, values: { invested: a.monthly_amount * n, p10: det * (1 - 1.28 * k), p50: det * (1 - 0.1 * k), p90: det * (1 + 1.28 * k * 1.5), mean: det, prob_loss_percent: a.annual_return < 0 ? 60 : 2, min: det * 0.5, max: det * 2, simulations: 5000, months: n } };
  },
  simulateLumpsum(a) {
    const det = a.principal * Math.pow(1 + a.annual_return / 100 / (a.compounds_per_year || 1), (a.compounds_per_year || 1) * a.years);
    const k = a.annual_volatility / 100;
    return { ok: true, values: { invested: a.principal, p10: det * (1 - k), p50: det, p90: det * (1 + k), mean: det, prob_loss_percent: 5, min: det * 0.5, max: det * 2, simulations: 5000, months: a.years * 12 } };
  },
  sipGoalProbability() { return { ok: true, values: { probability_percent: 40, median: 1 } }; }
});

test('all seven tools are exported with name, params, required and run', () => {
  assert.equal(tools.TOOLS.length, 7);
  for (const t of tools.TOOLS) {
    assert.ok(t.name && t.description && t.params && Array.isArray(t.required) && typeof t.run === 'function', t.name);
    for (const k of t.required) assert.ok(k in t.params, t.name + ' requires unknown param ' + k);
  }
});

test('income tax: known answers under the rules in lib/tax-rules.js', () => {
  const a = runChecked('calc_income_tax', { annual_income: 1500000 });
  assert.equal(a.check.ok, true);
  assert.equal(inr(a.result.new_regime.total_tax), 97500);          // taxable 14,25,000: 20,000 + 40,000 + 33,750 = 93,750 + 4% cess
  assert.equal(inr(a.result.old_regime.total_tax), 257400);         // no deductions: taxable 14,50,000
  assert.equal(a.result.cheaper_regime, 'new regime');

  const b = runChecked('calc_income_tax', { annual_income: 1275000, regime: 1 });
  assert.equal(inr(b.result.new_regime.total_tax), 0);              // taxable 12,00,000 -> rebate 87A wipes the tax

  const c = runChecked('calc_income_tax', { annual_income: 1500000, regime: 2, deductions: 150000 });
  assert.equal(inr(c.result.old_regime.total_tax), 210600);         // taxable 13,00,000: 12,500 + 1,00,000 + 90,000 = 2,02,500 + 4% cess
  assert.equal(c.check.ok, true);
});

test('loan prepayment: EMI stays, tenure falls (known answers)', () => {
  const x = runChecked('calc_loan_prepayment', { principal: 5000000, annual_rate: 8.5, years: 20, extra_monthly: 10000 });
  assert.equal(x.check.ok, true);
  assert.equal(x.result.new_tenure_months, 155);
  assert.equal(x.result.months_saved, 85);
  assert.ok(Math.abs(inr(x.result.interest_saved) - 2178721) <= 1);

  const y = runChecked('calc_loan_prepayment', { principal: 5000000, annual_rate: 8.5, years: 20, lump_sum: 500000, lump_after_month: 12 });
  assert.equal(y.result.new_tenure_months, 192);
  assert.throws(() => tools.TOOLS[2].run({ principal: 5000000, annual_rate: 8.5, years: 20 }), /extra_monthly/);
});

test('EMI rate table and yearly schedule', () => {
  const t = runChecked('calc_emi_rate_table', { principal: 5000000, years: 20, rate_from: 7, rate_to: 10, step: 1 });
  assert.equal(t.check.ok, true);
  assert.equal(t.result.rows.length, 4);
  assert.equal(t.result.rows[0].monthly_emi, '₹38,765');

  const s = runChecked('calc_emi_schedule', { principal: 5000000, annual_rate: 8.5, years: 20 });
  assert.equal(s.check.ok, true);
  assert.equal(s.result.rows.length, 20);
  assert.equal(s.result.rows[0].opening_balance, '₹50,00,000');
  assert.equal(s.result.rows[19].closing_balance, '₹0');
  assert.equal(s.result.monthly_emi, '₹43,391');
  assert.ok(Math.abs(inr(s.result.total_interest) - 5413879) <= 2);
  const odd = runChecked('calc_emi_schedule', { principal: 100000, annual_rate: 10, years: 1.5 });
  assert.equal(odd.result.rows.length, 2);
  assert.equal(odd.check.ok, true);
});

test('independent check catches a wrong number in every JS-backed tool', () => {
  const cases = [
    ['calc_loan_prepayment', { principal: 5000000, annual_rate: 8.5, years: 20, extra_monthly: 10000 }, r => { r.interest_saved = '₹10,00,000'; }],
    ['calc_income_tax', { annual_income: 1500000 }, r => { r.new_regime.total_tax = '₹50,000'; }],
    ['calc_emi_rate_table', { principal: 5000000, years: 20, rate_from: 7, rate_to: 8, step: 1 }, r => { r.rows[1].monthly_emi = '₹1,000'; }],
    ['calc_emi_schedule', { principal: 5000000, annual_rate: 8.5, years: 20 }, r => { r.rows[3].interest_paid = '₹1'; }]
  ];
  for (const [name, args, tamper] of cases) {
    const { result, check } = runChecked(name, args);
    assert.equal(check.ok, true, name + ' should pass first');
    tamper(result);
    assert.equal(tools.verifyCalculation(name, args, result).ok, false, name + ' tampering must be caught');
  }
});

test('simulation tools: wiring, defaults and checks (stand-in bridge)', () => {
  tools.useBridge(standIn);
  try {
    const z = runChecked('calc_sip_simulation', { monthly_amount: 10000, annual_return: 12, years: 10, annual_volatility: 0 });
    assert.equal(z.check.ok, true);
    assert.equal(z.result.expected_median_p50, '₹23,23,391');
    assert.equal(z.result.volatility_was_assumed, false);

    const d = runChecked('calc_sip_simulation', { monthly_amount: 10000, annual_return: 12, years: 10, goal_amount: 3000000 });
    assert.equal(d.result.volatility_percent_used, 15);
    assert.equal(d.result.volatility_was_assumed, true);
    assert.equal(d.result.goal_chance_percent, 40);
    assert.equal(d.check.ok, true);

    const l = runChecked('calc_lumpsum_simulation', { principal: 100000, annual_return: 12, years: 5 });
    assert.equal(l.check.ok, true);
    assert.equal(l.result.total_invested, '₹1,00,000');

    const sc = runChecked('calc_sip_scenarios', { monthly_amount: 10000, years: 10, return_a: 10, return_b: 14, annual_volatility: 0 });
    assert.equal(sc.check.ok, true);
    assert.equal(sc.result.higher_median, 'scenario B');
    assert.ok(inr(sc.result.scenario_b.expected_median_p50) > inr(sc.result.scenario_a.expected_median_p50));
    sc.result.scenario_a.expected_median_p50 = '₹1,00,000';
    assert.equal(tools.verifyCalculation('calc_sip_scenarios', { monthly_amount: 10000, years: 10, return_a: 10, return_b: 14, annual_volatility: 0 }, sc.result).ok, false);
  } finally {
    tools.useBridge(null);
  }
});

test('simulation tools without WebAssembly: a clear error, never a made-up number', () => {
  tools.useBridge(Object.assign({}, realBridge, {
    simulateSip: () => ({ ok: false, code: 'ENGINE_UNAVAILABLE', error: 'Simulation engine abhi available nahi hai.' })
  }));
  try {
    assert.throws(() => tools.TOOLS[0].run({ monthly_amount: 10000, annual_return: 12, years: 10 }), /available nahi/);
    assert.equal(engine.runTool.length >= 0, true);
  } finally {
    tools.useBridge(null);
  }
});

test('bad tool inputs are refused', () => {
  const run = (name, a) => tools.TOOLS.find(t => t.name === name).run(a);
  assert.throws(() => run('calc_income_tax', { annual_income: -5 }), /allowed range/);
  assert.throws(() => run('calc_emi_schedule', { principal: 1000, annual_rate: 150, years: 5 }), /allowed range/);
  assert.throws(() => run('calc_emi_rate_table', { principal: 1000, years: 5, rate_from: 9, rate_to: 7 }), /rate range/);
  assert.throws(() => run('calc_emi_rate_table', { principal: 1000, years: 5, rate_from: 0, rate_to: 100, step: 0.01 }), /200 rows/);
  assert.throws(() => run('calc_sip_scenarios', { monthly_amount: 1000, years: 5, return_a: 12 }), /return_b/);
});

/* ---- wiring into the existing chat system ---- */
const U = t => [{ role: 'user', content: t }];

test('install() adds the tools once and never throws', () => {
  const before = engine.TOOLS.length;
  assert.equal(integration.install().installed, true);
  assert.equal(engine.TOOLS.length, before + 7);
  assert.equal(integration.install().installed, false);
  assert.equal(engine.TOOLS.length, before + 7);
  assert.equal(integration.install({ engine: null, validator: {}, router: {} }).installed, false);
});

test('questions reach the right tool; everything else stays on the old path', () => {
  const tool = q => (engine.buildContext(U(q)) || {}).tool;
  assert.equal(tool('10000 monthly SIP simulation 12% return 15% volatility 10 saal'), 'calc_sip_simulation');
  assert.equal(tool('1 lakh lumpsum simulation 12% return 15% volatility 5 saal'), 'calc_lumpsum_simulation');
  assert.equal(tool('5000000 home loan 8.5% 20 saal, har mahine 10000 extra payment karu to'), 'calc_loan_prepayment');
  assert.equal(tool('mera salary 15 lakh annual hai, income tax kitna lagega old vs new regime'), 'calc_income_tax');
  assert.equal(tool('50 lakh home loan 20 saal, 7% se 10% tak rates ka table step 1'), 'calc_emi_rate_table');
  assert.equal(tool('50 lakh home loan 8.5% 20 saal ka year-wise repayment schedule'), 'calc_emi_schedule');
  assert.equal(tool('SIP simulation 10000 monthly 10 saal, 12% return vs 8% return'), 'calc_sip_scenarios');
  // untouched
  assert.equal(tool('EMI on 50 lakh at 8.5% for 20 years'), 'calc_emi');
  assert.equal(tool('5000 SIP 12% 10 saal'), 'calc_sip');
  assert.equal(tool('SIP kya hai'), 'calc_sip');
  assert.equal(tool('hello, how are you'), null);
});

test('scenario comparison: two returns and a shared volatility are read correctly', () => {
  const c = engine.buildContext(U('SIP simulation 10000 monthly 10 saal, 12% return vs 8% return, volatility 20%'));
  assert.equal(c.tool, 'calc_sip_scenarios');
  assert.deepEqual([c.inputs.monthly_amount, c.inputs.years, c.inputs.return_a, c.inputs.return_b, c.inputs.annual_volatility], [10000, 10, 12, 8, 20]);
  assert.equal(c.complete, true);
});

test('missing inputs are asked for directly, with no AI call', () => {
  const r = router.route(U('SIP Monte Carlo simulation 10000 per month'));
  assert.equal(r.action, 'ask_clarification');
  assert.match(r.direct_reply, /expected annual return/);
  const r2 = router.route(U('50 lakh home loan ka year-wise schedule'));
  assert.equal(r2.action, 'ask_clarification');
  assert.match(r2.direct_reply, /interest rate/);
});

test('a follow-up answer fills the missing value', () => {
  const m = [{ role: 'user', content: '50 lakh home loan ka year-wise schedule' }, { role: 'assistant', content: 'rate batao' }, { role: 'user', content: '8.5% aur 20 saal' }];
  const c = engine.buildContext(m);
  assert.equal(c.tool, 'calc_emi_schedule');
  assert.equal(c.complete, true);
});

test('validator re-checks the new tools; old tools still use the old checks', () => {
  const args = { principal: 5000000, annual_rate: 8.5, years: 20 };
  const good = engine.runTool('calc_emi_schedule', args);
  assert.equal(validator.verifyCalculation('calc_emi_schedule', args, good).ok, true);
  good.rows[0].interest_paid = '₹5';
  assert.equal(validator.verifyCalculation('calc_emi_schedule', args, good).ok, false);
  const emi = engine.runTool('calc_emi', args);
  assert.equal(validator.verifyCalculation('calc_emi', args, emi).ok, true);
});
