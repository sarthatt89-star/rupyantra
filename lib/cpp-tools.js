'use strict';

/*
 * Rupeyantra calculator tools backed by the C++ engine (lib/cpp-tools.js)
 *
 * Tools (same shape as the tools in finance-engine.js, so chat.js can use them):
 *   calc_sip_simulation, calc_lumpsum_simulation, calc_loan_prepayment, calc_income_tax, calc_emi_rate_table
 * Each tool calls the C++ engine through lib/cpp-bridge.js. Prepayment, tax and the rate table also have a plain
 * JS fallback; simulations have none (they return a clear error when the engine is unavailable).
 *
 * verifyCalculation() re-computes every result with separate JS code (loops / hand-written slab logic),
 * so a bug in the C++ build cannot slip through unnoticed.
 */

const defaultBridge = require('./cpp-bridge');
const RULES = require('./tax-rules');

let bridge = defaultBridge;
function useBridge(b) { bridge = b || defaultBridge; }

/* ========== helpers ========== */

const isSet = v => v !== undefined && v !== null && v !== '';
const round2 = n => Math.round(n * 100) / 100;

function toNumber(value, name) {
  if (!isSet(value)) throw new Error(name + ' missing hai');
  if (typeof value === 'boolean') return value ? 1 : 0;
  let v = value;
  if (typeof v === 'string') {
    v = v.replace(/[₹,\s]/g, '');
    if (v === '') throw new Error(name + ' galat hai');
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(name + ' galat hai');
  return n;
}

function formatINR(value) {
  if (!Number.isFinite(value)) throw new Error('Amount calculate nahi ho paya.');
  const abs = Math.abs(value);
  const digits = abs < 100 ? 2 : 0;
  const txt = abs.toLocaleString('en-IN', { maximumFractionDigits: digits });
  const isZero = Number(txt.replace(/,/g, '')) === 0;
  return (value < 0 && !isZero ? '-' : '') + '₹' + txt;
}

function parseINR(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const neg = /^\s*-/.test(v);
  const n = Number(v.replace(/[₹,\s+-]/g, ''));
  return neg ? -n : n;
}

function amountOf(v, name) {
  const n = toNumber(v, name);
  if (n <= 0 || n > 1e12) throw new Error(name + ' allowed range mein nahi hai');
  return n;
}
function optAmount(v, name, def = 0) {
  if (!isSet(v)) return def;
  const n = toNumber(v, name);
  if (n < 0 || n > 1e12) throw new Error(name + ' allowed range mein nahi hai');
  return n;
}
function yearsOf(v, name = 'years') {
  const n = toNumber(v, name);
  if (n <= 0 || n > 100) throw new Error('Duration 0 se zyada aur 100 saal tak honi chahiye');
  return n;
}
function rateOf(v, name, min, max) {
  const n = toNumber(v, name);
  if (n < min || n > max) throw new Error(name + ' allowed range mein nahi hai');
  return n;
}
function monthsFromYears(years) {
  const n = Math.round(years * 12);
  if (n < 1 || n > 1200) throw new Error('Avadhi galat hai');
  return n;
}
function need(r) {
  if (r.ok) return r.values;
  throw new Error(r.error);
}

const DEFAULT_VOL = 15;

/* ========== independent JS implementations (also used as fallbacks) ========== */

function jsEmi(P, rate, n) {
  const r = rate / 1200;
  return r === 0 ? P / n : P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
}

function jsSipFv(P, rate, n) {
  const r = rate / 1200;
  let bal = 0;
  for (let i = 0; i < n; i++) bal = (bal + P) * (1 + r);
  return bal;
}

function jsPrepay(P, rate, n, extra, lump, lumpMonth) {
  const r = rate / 1200;
  const emi = jsEmi(P, rate, n);
  const baseInterest = emi * n - P;
  let bal = P, paid = 0, interest = 0, used = 0;
  for (let m = 1; m <= n; m++) {
    if (bal <= 0.005) break;
    const i = bal * r;
    const pay = Math.min(emi, bal + i);
    bal -= pay - i;
    const x = Math.min(extra, bal);
    bal -= x;
    paid += pay + x;
    interest += i;
    if (lump > 0 && m === lumpMonth) {
      const l = Math.min(lump, bal);
      bal -= l;
      paid += l;
    }
    used = m;
    if (bal <= 0.005) break;
  }
  return { base_emi: emi, base_months: n, base_interest: baseInterest, new_months: used, new_interest: interest,
    interest_saved: baseInterest - interest, months_saved: n - used, total_paid: paid };
}

function slabTax(slabs, income) {
  let tax = 0, lower = 0;
  for (let i = 0; i < slabs.length; i++) {
    const upper = i === slabs.length - 1 ? Infinity : slabs[i][0];
    if (income > lower) tax += (Math.min(income, upper) - lower) * slabs[i][1] / 100;
    lower = upper;
  }
  return tax;
}

function afterRebate(rule, income) {
  const slab = slabTax(rule.slabs, income);
  let rebate = 0;
  if (rule.rebate_limit > 0) {
    if (income <= rule.rebate_limit) rebate = Math.min(slab, rule.rebate_max);
    else if (rule.rebate_relief) {
      const excess = income - rule.rebate_limit;
      if (slab > excess) rebate = slab - excess;
    }
  }
  return { slab, rebate, tax: slab - rebate };
}

function jsTax(rule, income) {
  const a = afterRebate(rule, income);
  let tier = -1;
  rule.surcharge.forEach(([above], i) => { if (income > above) tier = i; });
  let surcharge = 0;
  if (tier >= 0) {
    const [above, rate] = rule.surcharge[tier];
    const prevRate = tier > 0 ? rule.surcharge[tier - 1][1] : 0;
    surcharge = a.tax * rate / 100;
    const cap = afterRebate(rule, above).tax * (1 + prevRate / 100) + (income - above);
    if (a.tax + surcharge > cap) surcharge = Math.max(0, cap - a.tax);
  }
  const cess = (a.tax + surcharge) * rule.cess / 100;
  const total = a.tax + surcharge + cess;
  return {
    slab_tax: a.slab, rebate: a.rebate, tax_after_rebate: a.tax, surcharge, cess, total_tax: total,
    effective_rate_percent: income > 0 ? total / income * 100 : 0, monthly_tax: total / 12,
    total_tax_rounded: Math.round(total / 10) * 10
  };
}

/* ========== tool: SIP simulation ========== */

function mcLines(v) {
  return {
    total_invested: formatINR(v.invested),
    worst_case_p10: formatINR(v.p10),
    expected_median_p50: formatINR(v.p50),
    best_case_p90: formatINR(v.p90),
    average_outcome: formatINR(v.mean),
    chance_of_loss_percent: round2(v.prob_loss_percent)
  };
}

const SIM_NOTE = 'Ye estimate hai: market ke kai kaalpanik raste chalakar nikala gaya, guarantee nahi. Worst case ka matlab 10% raste isse neeche rahe, best case ka matlab 90% raste isse neeche rahe.';

const TOOL_SIP_SIM = {
  name: 'calc_sip_simulation',
  description: 'SIP ka Monte Carlo simulation: worst/expected/best case, nuksan ki sambhavna aur (optional) goal tak pahunchne ki sambhavna. Estimate hai, guarantee nahi.',
  params: {
    monthly_amount: 'Monthly SIP amount rupaye mein',
    annual_return: 'Expected annual return percent mein',
    years: 'SIP duration years mein',
    annual_volatility: 'Annual volatility (utar-chadhav) percent mein; na ho to 15 maana jaata hai',
    goal_amount: 'Target amount jahan tak pahunchna hai (optional)'
  },
  required: ['monthly_amount', 'annual_return', 'years'],
  run(a) {
    const P = amountOf(a.monthly_amount, 'monthly_amount');
    const ret = rateOf(a.annual_return, 'annual_return', -50, 100);
    const years = yearsOf(a.years);
    const months = monthsFromYears(years);
    const given = isSet(a.annual_volatility);
    const vol = given ? rateOf(a.annual_volatility, 'annual_volatility', 0, 100) : DEFAULT_VOL;
    const goal = isSet(a.goal_amount) ? amountOf(a.goal_amount, 'goal_amount') : null;

    const input = { monthly_amount: P, annual_return: ret, annual_volatility: vol, years };
    const v = need(bridge.simulateSip(input));
    const out = Object.assign(mcLines(v), {
      simulations: v.simulations,
      volatility_percent_used: vol,
      volatility_was_assumed: !given
    });
    if (goal !== null) {
      const g = need(bridge.sipGoalProbability(Object.assign({ target_amount: goal }, input)));
      out.goal_amount = formatINR(goal);
      out.goal_chance_percent = round2(g.probability_percent);
    }
    out.note = SIM_NOTE;
    return out;
  }
};

/* ========== tool: lumpsum simulation ========== */

const TOOL_LUMP_SIM = {
  name: 'calc_lumpsum_simulation',
  description: 'Ek saath (lumpsum) investment ka Monte Carlo simulation: worst/expected/best case aur nuksan ki sambhavna. Estimate hai, guarantee nahi.',
  params: {
    principal: 'Ek saath invest ki jaane wali amount rupaye mein',
    annual_return: 'Expected annual return percent mein',
    years: 'Duration years mein',
    annual_volatility: 'Annual volatility percent mein; na ho to 15 maana jaata hai',
    compounds_per_year: 'Saal mein compounding; na ho to 1 maana jaata hai'
  },
  required: ['principal', 'annual_return', 'years'],
  run(a) {
    const P = amountOf(a.principal, 'principal');
    const ret = rateOf(a.annual_return, 'annual_return', -50, 100);
    const years = yearsOf(a.years);
    monthsFromYears(years);
    const given = isSet(a.annual_volatility);
    const vol = given ? rateOf(a.annual_volatility, 'annual_volatility', 0, 100) : DEFAULT_VOL;
    const cpy = isSet(a.compounds_per_year) ? toNumber(a.compounds_per_year, 'compounds_per_year') : 1;
    if (!Number.isInteger(cpy) || cpy < 1 || cpy > 365) throw new Error('compounds_per_year 1 se 365 ke beech poora number hona chahiye');

    const v = need(bridge.simulateLumpsum({ principal: P, annual_return: ret, annual_volatility: vol, years, compounds_per_year: cpy }));
    const out = mcLines(v);
    out.total_invested = formatINR(P);
    return Object.assign(out, {
      simulations: v.simulations,
      volatility_percent_used: vol,
      volatility_was_assumed: !given,
      compounds_per_year: cpy,
      note: SIM_NOTE
    });
  }
};

/* ========== tool: loan prepayment ========== */

function yearsMonthsText(months) {
  const y = Math.floor(months / 12), m = months % 12;
  if (y && m) return y + ' saal ' + m + ' mahine';
  if (y) return y + ' saal';
  return m + ' mahine';
}

const TOOL_PREPAY = {
  name: 'calc_loan_prepayment',
  description: 'Loan par extra payment (har mahine extra ya ek saath) karne se kitna interest bachega aur loan kitne mahine pehle khatam hoga. EMI wahi rehti hai, avadhi kam hoti hai.',
  params: {
    principal: 'Loan amount rupaye mein',
    annual_rate: 'Annual interest rate percent mein',
    years: 'Loan ki original avadhi years mein',
    extra_monthly: 'Har mahine EMI ke upar extra payment (optional)',
    lump_sum: 'Ek baar mein ek saath extra payment (optional)',
    lump_after_month: 'Ek saath payment loan shuru hone ke kitne mahine baad (lump_sum ke saath zaroori)'
  },
  required: ['principal', 'annual_rate', 'years'],
  run(a) {
    const P = amountOf(a.principal, 'principal');
    const rate = rateOf(a.annual_rate, 'annual_rate', 0, 100);
    const n = monthsFromYears(yearsOf(a.years));
    const extra = optAmount(a.extra_monthly, 'extra_monthly');
    const lump = optAmount(a.lump_sum, 'lump_sum');
    const after = isSet(a.lump_after_month) ? Math.round(toNumber(a.lump_after_month, 'lump_after_month')) : 0;
    if (extra === 0 && lump === 0) throw new Error('extra_monthly ya lump_sum dena zaroori hai');
    if (lump > 0 && (after < 1 || after > n)) throw new Error('lump_after_month 1 se loan ki avadhi ke beech hona chahiye');

    let r = bridge.loanPrepayment({ principal: P, annual_rate: rate, months: n, extra_monthly: extra, lump_sum: lump, lump_after_month: after });
    let v;
    if (r.ok) v = r.values;
    else if (r.code === 'ENGINE_UNAVAILABLE') v = jsPrepay(P, rate, n, extra, lump, after);
    else throw new Error(r.error);

    const out = {
      loan_amount: formatINR(P),
      monthly_emi: formatINR(v.base_emi),
      original_tenure_months: v.base_months,
      original_total_interest: formatINR(v.base_interest),
      new_tenure_months: v.new_months,
      new_tenure_text: yearsMonthsText(v.new_months),
      new_total_interest: formatINR(v.new_interest),
      interest_saved: formatINR(v.interest_saved),
      months_saved: v.months_saved,
      months_saved_text: yearsMonthsText(v.months_saved),
      total_paid_with_prepayment: formatINR(v.total_paid)
    };
    if (extra > 0) out.extra_monthly_payment = formatINR(extra);
    if (lump > 0) { out.lump_sum_payment = formatINR(lump); out.lump_sum_after_month = after; }
    out.note = 'EMI wahi rehti hai; extra payment se loan jaldi khatam hota hai. Lender ke prepayment charges ya rules alag ho sakte hain.';
    return out;
  }
};

/* ========== tool: income tax ========== */

const REGIME_KEYS = { 1: ['new'], 2: ['old'], 3: ['new', 'old'] };

function taxFor(rule, income) {
  const r = bridge.taxCompute(income, rule);
  if (r.ok) return r.values;
  if (r.code === 'ENGINE_UNAVAILABLE') return jsTax(rule, income);
  throw new Error(r.error);
}

function regimeBlock(key, income, deductions, salaried) {
  const rule = RULES[key];
  const std = salaried ? rule.standard_deduction : 0;
  const ded = rule.allows_deductions ? deductions : 0;
  const taxable = Math.max(0, income - std - ded);
  const t = taxFor(rule, taxable);
  return {
    numeric: t,
    block: {
      regime: rule.label,
      standard_deduction: formatINR(std),
      other_deductions: formatINR(ded),
      taxable_income: formatINR(taxable),
      tax_on_slabs: formatINR(t.slab_tax),
      rebate_87a: formatINR(t.rebate),
      surcharge: formatINR(t.surcharge),
      cess: formatINR(t.cess),
      total_tax: formatINR(t.total_tax),
      total_tax_rounded_to_10: formatINR(t.total_tax_rounded),
      effective_rate_percent: round2(t.effective_rate_percent),
      monthly_tax: formatINR(t.monthly_tax)
    }
  };
}

const TOOL_TAX = {
  name: 'calc_income_tax',
  description: 'Saal ki income par income tax (new aur/ya old regime) nikalta hai: standard deduction, rebate, surcharge aur cess ke saath. Niyam tax-rules file se aate hain; sirf normal slab income.',
  params: {
    annual_income: 'Saal ki total income (deductions se pehle) rupaye mein',
    deductions: 'Old regime ke liye total deductions (80C, 80D, HRA etc.); optional',
    regime: '1 = sirf new regime, 2 = sirf old regime, 3 = dono ki tulna (default 3)',
    salaried: '1 = salary/pension (standard deduction milti hai, default), 0 = nahi'
  },
  required: ['annual_income'],
  run(a) {
    const income = amountOf(a.annual_income, 'annual_income');
    const deductions = optAmount(a.deductions, 'deductions');
    const regime = isSet(a.regime) ? Math.round(toNumber(a.regime, 'regime')) : 3;
    if (!REGIME_KEYS[regime]) throw new Error('regime 1, 2 ya 3 hona chahiye');
    const salaried = isSet(a.salaried) ? toNumber(a.salaried, 'salaried') !== 0 : true;

    const keys = REGIME_KEYS[regime];
    const res = keys.map(k => regimeBlock(k, income, deductions, salaried));
    const out = {
      financial_year: RULES.fy,
      assessment_year: RULES.ay,
      rules_checked_on: RULES.checked_on,
      annual_income: formatINR(income)
    };
    keys.forEach((k, i) => { out[k + '_regime'] = res[i].block; });

    if (keys.length === 2) {
      const diff = res[1].numeric.total_tax - res[0].numeric.total_tax; // old - new
      out.cheaper_regime = Math.abs(diff) < 0.5 ? 'dono barabar' : diff > 0 ? 'new regime' : 'old regime';
      out.saving_with_cheaper_regime = formatINR(Math.abs(diff));
    }
    if (new Date() > new Date(RULES.valid_until + 'T23:59:59+05:30')) {
      out.warning = 'Ye niyam FY ' + RULES.fy + ' ke hain; naya saal shuru ho chuka hai, official site se dobara check karo.';
    }
    out.note = RULES.scope + ' ' + (salaried ? 'Salaried maan kar standard deduction li gayi.' : 'Standard deduction nahi li gayi.') +
      ' Old regime mein sirf aapke diye deductions ginne gaye.';
    return out;
  }
};

/* ========== tool: EMI vs interest rate table ========== */

const TOOL_RATE_TABLE = {
  name: 'calc_emi_rate_table',
  description: 'Ek hi loan ki EMI aur total interest alag-alag interest rates par (rate_from se rate_to tak, step ke gap par) table ke roop mein.',
  params: {
    principal: 'Loan amount rupaye mein',
    years: 'Loan avadhi years mein',
    rate_from: 'Table ka sabse kam rate percent mein',
    rate_to: 'Table ka sabse zyada rate percent mein',
    step: 'Rates ke beech ka gap percent mein; na ho to 0.5'
  },
  required: ['principal', 'years', 'rate_from', 'rate_to'],
  run(a) {
    const P = amountOf(a.principal, 'principal');
    const n = monthsFromYears(yearsOf(a.years));
    const from = rateOf(a.rate_from, 'rate_from', 0, 100);
    const to = rateOf(a.rate_to, 'rate_to', 0, 100);
    const step = isSet(a.step) ? toNumber(a.step, 'step') : 0.5;
    if (!(step > 0) || from > to) throw new Error('rate range ya gap sahi nahi hai');
    if ((to - from) / step > 199 + 1e-9) throw new Error('rates ki table 200 rows se badi nahi ho sakti');

    let rows;
    const r = bridge.emiRateSweep({ principal: P, months: n, rate_from: from, rate_to: to, step });
    if (r.ok) rows = r.values.rows;
    else if (r.code === 'ENGINE_UNAVAILABLE') {
      const count = Math.floor((to - from) / step + 1e-9) + 1;
      rows = Array.from({ length: count }, (_, i) => {
        const rate = from + i * step;
        const emi = jsEmi(P, rate, n);
        return { rate, emi, total_interest: emi * n - P };
      });
    } else throw new Error(r.error);

    const first = rows[0], last = rows[rows.length - 1];
    return {
      loan_amount: formatINR(P),
      tenure_months: n,
      rows: rows.map(x => ({ rate_percent: round2(x.rate), monthly_emi: formatINR(x.emi), total_interest: formatINR(x.total_interest) })),
      emi_at_lowest_rate: formatINR(first.emi),
      emi_at_highest_rate: formatINR(last.emi),
      emi_difference: formatINR(last.emi - first.emi),
      interest_difference: formatINR(last.total_interest - first.total_interest),
      note: 'Actual EMI lender ke rate, fees aur terms ke hisaab se alag ho sakti hai.'
    };
  }
};

const TOOLS = [TOOL_SIP_SIM, TOOL_LUMP_SIM, TOOL_PREPAY, TOOL_TAX, TOOL_RATE_TABLE];
const NAMES = new Set(TOOLS.map(t => t.name));
const isOurTool = name => NAMES.has(name);

/* ========== independent verification ========== */

function verifyCalculation(tool, rawArgs, result) {
  const checks = [];
  const add = (name, expected, got, tol) => checks.push({ name, expected, got, ok: Number.isFinite(expected) && Number.isFinite(got) && Math.abs(expected - got) <= tol });
  const fail = msg => ({ ok: false, status: 'error', checks, errors: [{ code: 'CALC_MISMATCH', field: null, message: msg }], warnings: [] });

  if (!result || typeof result !== 'object' || result.error) return fail('Calculator ne result nahi diya.');
  const a = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

  try {
    switch (tool) {
      case 'calc_sip_simulation':
      case 'calc_lumpsum_simulation': {
        const sip = tool === 'calc_sip_simulation';
        const years = Number(toNumber(a.years, 'years'));
        const n = Math.round(years * 12);
        const vol = Number(result.volatility_percent_used);
        const ret = toNumber(a.annual_return, 'annual_return');
        let det, invested;
        if (sip) {
          const P = toNumber(a.monthly_amount, 'monthly_amount');
          det = jsSipFv(P, ret, n);
          invested = P * n;
        } else {
          const P = toNumber(a.principal, 'principal');
          const m = Number(result.compounds_per_year);
          det = P * Math.pow(1 + ret / 100 / m, m * n / 12);
          invested = P;
        }
        const p10 = parseINR(result.worst_case_p10), p50 = parseINR(result.expected_median_p50), p90 = parseINR(result.best_case_p90);
        const mean = parseINR(result.average_outcome);
        add('invested', invested, parseINR(result.total_invested), 1.01);
        add('p10<=p50', 1, p10 <= p50 + 1 ? 1 : 0, 0);
        add('p50<=p90', 1, p50 <= p90 + 1 ? 1 : 0, 0);
        add('loss_chance_range', 1, result.chance_of_loss_percent >= 0 && result.chance_of_loss_percent <= 100 ? 1 : 0, 0);
        if (vol === 0) {
          add('median=closed_form', det, p50, Math.max(1.01, det * 1e-9));
          add('mean=closed_form', det, mean, Math.max(1.01, det * 1e-9));
        } else if (vol <= 30) {
          add('mean_near_closed_form', 1, mean >= det * 0.85 && mean <= det * 1.15 ? 1 : 0, 0);
        }
        if (isSet(result.goal_chance_percent)) {
          const g = Number(result.goal_chance_percent);
          add('goal_chance_range', 1, g >= 0 && g <= 100 ? 1 : 0, 0);
          if (sip && vol === 0) add('goal_chance_exact', det >= parseINR(result.goal_amount) ? 100 : 0, g, 0.01);
        }
        break;
      }
      case 'calc_loan_prepayment': {
        const P = toNumber(a.principal, 'principal');
        const rate = toNumber(a.annual_rate, 'annual_rate');
        const n = Math.round(toNumber(a.years, 'years') * 12);
        const extra = isSet(a.extra_monthly) ? toNumber(a.extra_monthly, 'extra_monthly') : 0;
        const lump = isSet(a.lump_sum) ? toNumber(a.lump_sum, 'lump_sum') : 0;
        const after = isSet(a.lump_after_month) ? Math.round(toNumber(a.lump_after_month, 'lump_after_month')) : 0;
        const v = jsPrepay(P, rate, n, extra, lump, after);
        add('emi', v.base_emi, parseINR(result.monthly_emi), 1.01);
        add('new_months', v.new_months, Number(result.new_tenure_months), 0);
        add('months_saved', v.months_saved, Number(result.months_saved), 0);
        add('new_interest', v.new_interest, parseINR(result.new_total_interest), 1.5);
        add('interest_saved', v.interest_saved, parseINR(result.interest_saved), 1.5);
        add('total_paid', v.total_paid, parseINR(result.total_paid_with_prepayment), 1.5);
        break;
      }
      case 'calc_income_tax': {
        const income = toNumber(a.annual_income, 'annual_income');
        const ded = isSet(a.deductions) ? toNumber(a.deductions, 'deductions') : 0;
        const salaried = isSet(a.salaried) ? toNumber(a.salaried, 'salaried') !== 0 : true;
        for (const key of ['new', 'old']) {
          const block = result[key + '_regime'];
          if (!block) continue;
          const rule = RULES[key];
          const taxable = Math.max(0, income - (salaried ? rule.standard_deduction : 0) - (rule.allows_deductions ? ded : 0));
          const t = jsTax(rule, taxable);
          add(key + '_taxable', taxable, parseINR(block.taxable_income), 1.01);
          add(key + '_total_tax', t.total_tax, parseINR(block.total_tax), 1.01);
          add(key + '_surcharge', t.surcharge, parseINR(block.surcharge), 1.01);
          add(key + '_rebate', t.rebate, parseINR(block.rebate_87a), 1.01);
        }
        if (result.new_regime && result.old_regime) {
          const diff = parseINR(result.old_regime.total_tax) - parseINR(result.new_regime.total_tax);
          add('saving', Math.abs(diff), parseINR(result.saving_with_cheaper_regime), 1.5);
        }
        break;
      }
      case 'calc_emi_rate_table': {
        const P = toNumber(a.principal, 'principal');
        const n = Math.round(toNumber(a.years, 'years') * 12);
        const rows = Array.isArray(result.rows) ? result.rows : [];
        add('rows', 1, rows.length >= 1 ? 1 : 0, 0);
        rows.forEach((row, i) => {
          const e = jsEmi(P, Number(row.rate_percent), n);
          add('emi_row_' + i, e, parseINR(row.monthly_emi), 1.01);
          add('interest_row_' + i, e * n - P, parseINR(row.total_interest), n * 0.01 + 1.5);
        });
        break;
      }
      default:
        return fail('Unknown tool');
    }
  } catch (e) {
    return fail('Verification chal nahi payi.');
  }

  const bad = checks.filter(c => !c.ok);
  return bad.length
    ? fail('Independent check se ye match nahi hua: ' + bad.map(b => b.name).join(', ') + '.')
    : { ok: true, status: 'ok', checks, errors: [], warnings: [] };
}

/* ========== readable text ========== */

const PARAM = {
  monthly_amount: ['mahine ki SIP amount', 'inr', 'mahine ki SIP amount'],
  annual_return: ['expected return', 'pct', 'expected annual return (% mein)'],
  annual_volatility: ['volatility', 'pct', 'volatility (% mein)'],
  years: ['avadhi', 'yrs', 'avadhi (kitne saal)'],
  goal_amount: ['goal', 'inr', 'goal amount'],
  principal: ['amount', 'inr', 'loan/investment amount'],
  annual_rate: ['interest rate', 'pct', 'interest rate (% mein)'],
  extra_monthly: ['har mahine extra payment', 'inr', 'har mahine kitna extra'],
  lump_sum: ['ek saath extra payment', 'inr', 'ek saath kitna extra'],
  lump_after_month: ['ek saath payment', 'mths', 'ek saath payment loan ke kitne mahine baad'],
  annual_income: ['saal ki income', 'inr', 'saal ki total income'],
  deductions: ['deductions', 'inr', 'deductions'],
  regime: ['regime', 'regime', 'regime'],
  salaried: ['salaried', 'flag', 'salaried hai ya nahi'],
  rate_from: ['rate (se)', 'pct', 'rate range ka shuru (% mein)'],
  rate_to: ['rate (tak)', 'pct', 'rate range ka ant (% mein)'],
  step: ['rate ka gap', 'pct', 'rate ka gap (% mein)'],
  prepay: ['', '', 'extra payment: har mahine kitna ya ek saath kitna']
};

function fmtParam(k, v) {
  const kind = (PARAM[k] || [])[1];
  const n = Number(v);
  if (kind === 'pct') return n + '%';
  if (kind === 'yrs') return n + ' saal';
  if (kind === 'mths') return n + ' mahine';
  if (kind === 'regime') return n === 1 ? 'new' : n === 2 ? 'old' : 'dono';
  if (kind === 'flag') return n === 0 ? 'nahi' : 'haan';
  return formatINR(n);
}

const isOurKey = k => Object.prototype.hasOwnProperty.call(PARAM, k);

function describeInput(k, v) {
  return (PARAM[k] ? PARAM[k][0] : k) + ' ' + fmtParam(k, v);
}

function resultLines(name, args, r) {
  switch (name) {
    case 'calc_sip_simulation':
    case 'calc_lumpsum_simulation': {
      const lines = [
        'Total invest: ' + r.total_invested,
        'Worst case (10% raste isse neeche): ' + r.worst_case_p10,
        'Expected (beech ka): ' + r.expected_median_p50,
        'Best case (90% raste isse neeche): ' + r.best_case_p90,
        'Average: ' + r.average_outcome,
        'Nuksan ki sambhavna: ' + r.chance_of_loss_percent + '%'
      ];
      if (isSet(r.goal_chance_percent)) lines.push('Goal ' + r.goal_amount + ' tak pahunchne ki sambhavna: ' + r.goal_chance_percent + '%');
      lines.push('Volatility ' + r.volatility_percent_used + '% ' + (r.volatility_was_assumed ? '(maani gayi)' : '(aapki di hui)') + ', ' + r.simulations + ' simulations.');
      lines.push(r.note);
      return lines;
    }
    case 'calc_loan_prepayment': {
      const lines = [
        'Loan ' + r.loan_amount + ', EMI ' + r.monthly_emi + ' (wahi rehti hai)',
        'Pehle: ' + r.original_tenure_months + ' mahine, total interest ' + r.original_total_interest,
        'Extra payment ke baad: ' + r.new_tenure_months + ' mahine (' + r.new_tenure_text + '), total interest ' + r.new_total_interest,
        'Interest ki bachat: ' + r.interest_saved,
        'Loan ' + r.months_saved + ' mahine (' + r.months_saved_text + ') pehle khatam',
        'Total chukaya (extra samet): ' + r.total_paid_with_prepayment
      ];
      lines.push(r.note);
      return lines;
    }
    case 'calc_income_tax': {
      const lines = ['FY ' + r.financial_year + ' (AY ' + r.assessment_year + '), income ' + r.annual_income];
      for (const k of ['new', 'old']) {
        const b = r[k + '_regime'];
        if (!b) continue;
        lines.push(b.regime + ': taxable ' + b.taxable_income + ', tax ' + b.total_tax + ' (rebate ' + b.rebate_87a + ', surcharge ' + b.surcharge + ', cess ' + b.cess + '), mahine ka ' + b.monthly_tax);
      }
      if (r.cheaper_regime) lines.push('Sasta: ' + r.cheaper_regime + ' (bachat ' + r.saving_with_cheaper_regime + ')');
      if (r.warning) lines.push(r.warning);
      lines.push(r.note);
      return lines;
    }
    case 'calc_emi_rate_table':
      return ['Loan ' + r.loan_amount + ', ' + r.tenure_months + ' mahine'].concat(
        r.rows.map(x => x.rate_percent + '%: EMI ' + x.monthly_emi + ', total interest ' + x.total_interest),
        ['Sabse kam se sabse zyada rate par EMI ka fark: ' + r.emi_difference, r.note]);
    default:
      return [JSON.stringify(r)];
  }
}

module.exports = {
  TOOLS, isOurTool, verifyCalculation, resultLines, describeInput, isOurKey, PARAM, fmtParam,
  jsEmi, jsSipFv, jsPrepay, jsTax, formatINR, parseINR, useBridge, DEFAULT_VOL
};
