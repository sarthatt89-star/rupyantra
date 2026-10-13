'use strict';

/*
 * Rupeyantra Finance Engine (authoritative)
 *
 * Calculation rules (tests/finance-engine.test.js mein lock hain):
 * - EMI: reducing balance, monthly rate = annual/12, n = round(months). Zero rate => P/n.
 * - SIP: monthly rate = annual/12 (nominal), n = round(years*12),
 *        deposits mahine ki SHURUAT mein (annuity-due): FV = P*((1+r)^n-1)/r*(1+r).
 * - FD/lumpsum: P*(1 + rate/m)^(m*years), default m = 4 (quarterly).
 * - Budget goal: SIP wali hi convention (monthly compounding, deposit mahine ki shuruat mein).
 * - Display: ₹100 se bade amounts nearest rupee, chhote amounts 2 decimals tak.
 * chat.js mein koi formula nahi hona chahiye; sab yahin se aata hai.
 *
 * Is file ke hisse:
 *   1. Helpers + validation
 *   2. Calculators (TOOLS)
 *   3. Intent detection + trusted sources
 *   4. Input extraction (Hinglish/Hindi text se amount, rate, avadhi)
 *   5. Conversation context (pichhle messages se calculation yaad rakhna)
 *   6. Hint / reply text / reply verification
 */

const LIMITS = Object.freeze({
  maxAmount: 1e12,
  maxYears: 100,
  maxRate: 100,
  maxMonths: 1200
});

/* ========== 1. helpers + validation ========== */

const parseNum = s => Number(String(s).replace(/,/g, ''));
const round2 = n => Math.round(n * 100) / 100;
const isSet = v => v !== undefined && v !== null && v !== '';

function toNumber(value, name) {
  if (!isSet(value)) throw new Error(name + ' missing hai');
  if (typeof value === 'boolean') return value ? 1 : 0;

  let v = value;
  if (typeof v === 'string') {
    v = v.replace(/[₹,\s]/g, '')
      .replace(/^(true|yes)$/i, '1')
      .replace(/^(false|no)$/i, '0');
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

const signedINR = d => (d >= 0 ? '+' : '-') + formatINR(Math.abs(d));

function amountOf(v, name) {
  const n = toNumber(v, name);
  if (n <= 0 || n > LIMITS.maxAmount) throw new Error(name + ' allowed range mein nahi hai');
  return n;
}

function yearsOf(v, name = 'years') {
  const n = toNumber(v, name);
  if (n <= 0 || n > LIMITS.maxYears) throw new Error('Duration 0 se zyada aur 100 saal tak honi chahiye');
  return n;
}

function rateOf(v, name, min = 0, max = LIMITS.maxRate) {
  const n = toNumber(v, name);
  if (n < min || n > max) throw new Error(name + ' allowed range mein nahi hai');
  return n;
}

/* ---------- numeric cores ---------- */

function emiNumbers(P, rate, n) {
  const r = rate / 1200;
  const emi = r === 0
    ? P / n
    : P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  return { emi, total: emi * n, interest: emi * n - P };
}

function sipNumbers(P, rate, n) {
  const r = rate / 1200;
  const invested = P * n;
  const fv = r === 0 ? invested : P * ((Math.pow(1 + r, n) - 1) / r) * (1 + r);
  return { invested, fv, gain: fv - invested };
}

function termMonths(a) {
  const n = Math.round(isSet(a.months) ? toNumber(a.months, 'months') : yearsOf(a.years) * 12);
  if (n < 1 || n > LIMITS.maxMonths) throw new Error('Loan avadhi galat hai');
  return n;
}

/* ========== 2. calculators (TOOLS) ========== */

const TOOLS = [
  {
    name: 'calc_emi',
    description: 'Loan ki EMI, total interest aur total payment calculate karta hai.',
    params: {
      principal: 'Loan amount rupaye mein',
      annual_rate: 'Annual interest rate percent mein',
      years: 'Loan term years mein; months na diya ho to zaroori',
      months: 'Loan term months mein; years ke badle use ho sakta hai'
    },
    required: ['principal', 'annual_rate'],
    run(a) {
      const P = amountOf(a.principal, 'principal');
      const rate = rateOf(a.annual_rate, 'annual_rate');
      const n = termMonths(a);
      const x = emiNumbers(P, rate, n);
      return {
        monthly_emi: formatINR(x.emi),
        monthly_emi_exact: round2(x.emi),
        months: n,
        total_payment: formatINR(x.total),
        total_interest: formatINR(x.interest)
      };
    }
  },
  {
    name: 'calc_sip',
    description: 'Monthly SIP ka estimated future value (monthly compounding, deposit mahine ki shuruat mein). Returns guaranteed nahi.',
    params: {
      monthly_amount: 'Monthly SIP amount',
      annual_return: 'Assumed annual return percent',
      years: 'SIP duration years mein'
    },
    required: ['monthly_amount', 'annual_return', 'years'],
    run(a) {
      const P = amountOf(a.monthly_amount, 'monthly_amount');
      const rate = rateOf(a.annual_return, 'annual_return', -50, LIMITS.maxRate);
      const n = Math.round(yearsOf(a.years) * 12);
      if (n < 1) throw new Error('SIP avadhi kam se kam 1 mahina honi chahiye');
      const x = sipNumbers(P, rate, n);
      return {
        total_invested: formatINR(x.invested),
        future_value: formatINR(x.fv),
        estimated_gain: formatINR(x.gain),
        note: 'Estimate hai; market returns guaranteed nahi.'
      };
    }
  },
  {
    name: 'calc_lumpsum',
    description: 'Lumpsum/FD compound-interest maturity calculate karta hai.',
    params: {
      principal: 'Investment amount',
      annual_rate: 'Annual interest rate percent',
      years: 'Duration years mein',
      compounds_per_year: 'Compounding per year; default 4 (quarterly)'
    },
    required: ['principal', 'annual_rate', 'years'],
    run(a) {
      const P = amountOf(a.principal, 'principal');
      const rate = rateOf(a.annual_rate, 'annual_rate', -50, LIMITS.maxRate);
      const t = yearsOf(a.years);
      const m = isSet(a.compounds_per_year) ? toNumber(a.compounds_per_year, 'compounds_per_year') : 4;

      if (!Number.isInteger(m) || m < 1 || m > 365) {
        throw new Error('compounds_per_year 1 se 365 ke beech poora number hona chahiye');
      }

      const maturity = P * Math.pow(1 + rate / 100 / m, m * t);
      return {
        maturity_amount: formatINR(maturity),
        interest_earned: formatINR(maturity - P),
        compounds_per_year: m
      };
    }
  },
  {
    name: 'calc_cagr',
    description: 'Starting aur ending value se annual CAGR calculate karta hai.',
    params: {
      start_value: 'Starting value',
      end_value: 'Ending value',
      years: 'Duration years mein'
    },
    required: ['start_value', 'end_value', 'years'],
    run(a) {
      const s = amountOf(a.start_value, 'start_value');
      const e = amountOf(a.end_value, 'end_value');
      const y = yearsOf(a.years);
      return { cagr_percent: round2((Math.pow(e / s, 1 / y) - 1) * 100) };
    }
  },
  {
    name: 'calc_simple_interest',
    description: 'Simple interest aur total amount calculate karta hai.',
    params: {
      principal: 'Principal amount',
      annual_rate: 'Annual interest rate percent',
      years: 'Duration years mein'
    },
    required: ['principal', 'annual_rate', 'years'],
    run(a) {
      const P = amountOf(a.principal, 'principal');
      const rate = rateOf(a.annual_rate, 'annual_rate');
      const t = yearsOf(a.years);
      const interest = P * rate * t / 100;
      return { interest: formatINR(interest), total_amount: formatINR(P + interest) };
    }
  },
  {
    name: 'calc_gst',
    description: 'GST amount aur total bill calculate karta hai. inclusive=1 jab GST amount mein included ho, otherwise 0.',
    params: {
      amount: 'Amount rupaye mein',
      gst_rate: 'GST rate percent mein',
      inclusive: '1 if GST included, otherwise 0'
    },
    required: ['amount', 'gst_rate', 'inclusive'],
    run(a) {
      const amount = toNumber(a.amount, 'amount');
      const rate = rateOf(a.gst_rate, 'gst_rate');
      const inc = toNumber(a.inclusive, 'inclusive');

      if (amount < 0 || amount > LIMITS.maxAmount) throw new Error('amount allowed range mein nahi hai');
      if (![0, 1].includes(inc)) throw new Error('inclusive sirf 0 ya 1 ho sakta hai');

      if (inc === 1) {
        const base = amount / (1 + rate / 100);
        return {
          base_amount: formatINR(base),
          gst_amount: formatINR(amount - base),
          total_amount: formatINR(amount),
          mode: 'GST included'
        };
      }

      const gst = amount * rate / 100;
      return {
        base_amount: formatINR(amount),
        gst_amount: formatINR(gst),
        total_amount: formatINR(amount + gst),
        mode: 'GST extra'
      };
    }
  },
  {
    name: 'calc_inflation',
    description: 'Assumed inflation se future cost estimate karta hai; future inflation guaranteed nahi.',
    params: {
      current_amount: 'Aaj ki amount rupaye mein',
      annual_inflation: 'Assumed annual inflation percent',
      years: 'Duration years mein'
    },
    required: ['current_amount', 'annual_inflation', 'years'],
    run(a) {
      const amount = amountOf(a.current_amount, 'current_amount');
      const rate = rateOf(a.annual_inflation, 'annual_inflation', -20, LIMITS.maxRate);
      const years = yearsOf(a.years);
      const future = amount * Math.pow(1 + rate / 100, years);
      return {
        future_cost_estimate: formatINR(future),
        extra_cost_estimate: formatINR(future - amount),
        note: 'Assumption-based estimate hai.'
      };
    }
  },
  {
    name: 'compare_emi',
    description: 'Ek hi loan ke alag interest rate ya alag tenure ki EMI compare karta hai. alt_annual_rate ya alt_years (ya dono) dena zaroori hai.',
    params: {
      principal: 'Loan amount rupaye mein',
      annual_rate: 'Base annual interest rate percent',
      years: 'Base loan term years mein',
      alt_annual_rate: 'Compare karne ke liye doosra interest rate percent',
      alt_years: 'Compare karne ke liye doosra tenure years mein'
    },
    required: ['principal', 'annual_rate', 'years'],
    run(a) {
      const P = amountOf(a.principal, 'principal');
      const rate = rateOf(a.annual_rate, 'annual_rate');
      const years = yearsOf(a.years);
      const hasRate = isSet(a.alt_annual_rate);
      const hasYears = isSet(a.alt_years);
      if (!hasRate && !hasYears) throw new Error('alt_annual_rate ya alt_years dena zaroori hai');

      const altRate = hasRate ? rateOf(a.alt_annual_rate, 'alt_annual_rate') : rate;
      const altYears = hasYears ? yearsOf(a.alt_years, 'alt_years') : years;

      const defs = [['base', rate, years]];
      if (hasRate) defs.push(['alt_rate', altRate, years]);
      if (hasYears) defs.push(['alt_tenure', rate, altYears]);
      if (hasRate && hasYears) defs.push(['alt_rate_and_tenure', altRate, altYears]);

      const rows = defs.map(([label, rt, yrs]) => {
        const n = Math.round(yrs * 12);
        if (n < 1 || n > LIMITS.maxMonths) throw new Error('Loan avadhi galat hai');
        return { label, rt, yrs, n, x: emiNumbers(P, rt, n) };
      });
      const base = rows[0].x;

      return {
        principal: formatINR(P),
        scenarios: rows.map(r => ({
          label: r.label,
          annual_rate: r.rt,
          years: r.yrs,
          monthly_emi: formatINR(r.x.emi),
          total_interest: formatINR(r.x.interest),
          total_payment: formatINR(r.x.total),
          emi_vs_base: r.label === 'base' ? '-' : signedINR(r.x.emi - base.emi),
          interest_vs_base: r.label === 'base' ? '-' : signedINR(r.x.interest - base.interest)
        }))
      };
    }
  },
  {
    name: 'compare_sip',
    description: 'SIP ke conservative, moderate aur higher assumed returns compare karta hai. Sirf illustrative assumptions; returns guaranteed nahi.',
    params: {
      monthly_amount: 'Monthly SIP amount',
      years: 'SIP duration years mein',
      conservative_return: 'Conservative assumed annual return percent (default 6)',
      moderate_return: 'Moderate assumed annual return percent (default 10)',
      high_return: 'Higher assumed annual return percent (default 14)'
    },
    required: ['monthly_amount', 'years'],
    run(a) {
      const P = amountOf(a.monthly_amount, 'monthly_amount');
      const years = yearsOf(a.years);
      const n = Math.round(years * 12);
      if (n < 1) throw new Error('SIP avadhi kam se kam 1 mahina honi chahiye');

      const pick = (v, d, name) => (isSet(v) ? rateOf(v, name, -50, LIMITS.maxRate) : d);
      const defs = [
        ['conservative', pick(a.conservative_return, 6, 'conservative_return')],
        ['moderate', pick(a.moderate_return, 10, 'moderate_return')],
        ['high', pick(a.high_return, 14, 'high_return')]
      ];

      return {
        total_invested: formatINR(P * n),
        scenarios: defs.map(([label, rt]) => {
          const x = sipNumbers(P, rt, n);
          return {
            label,
            assumed_return_percent: rt,
            future_value: formatINR(x.fv),
            estimated_gain: formatINR(x.gain)
          };
        }),
        note: 'Ye sirf assumptions hain; market returns guaranteed nahi hain.'
      };
    }
  },
  {
    name: 'calc_budget',
    description: 'Income aur kharche se monthly surplus, savings rate, 50/30/20 benchmark aur (optional) goal tak pahunchne ka estimate nikalta hai.',
    params: {
      monthly_income: 'Mahine ki income rupaye mein',
      monthly_expenses: 'Mahine ka total kharcha rupaye mein',
      goal_amount: 'Savings goal amount (optional)',
      current_savings: 'Abhi tak ki savings (optional)',
      annual_return: 'Savings par assumed annual return percent (optional, default 0)'
    },
    required: ['monthly_income', 'monthly_expenses'],
    run(a) {
      const income = amountOf(a.monthly_income, 'monthly_income');
      const exp = toNumber(a.monthly_expenses, 'monthly_expenses');
      if (exp < 0 || exp > LIMITS.maxAmount) throw new Error('monthly_expenses allowed range mein nahi hai');

      const surplus = income - exp;
      const out = {
        monthly_surplus: formatINR(surplus),
        savings_rate_percent: round2(surplus / income * 100),
        expense_ratio_percent: round2(exp / income * 100),
        status: surplus > 0 ? 'surplus' : surplus === 0 ? 'break_even' : 'deficit',
        benchmark_50_30_20: {
          needs: formatINR(income * 0.5),
          wants: formatINR(income * 0.3),
          savings: formatINR(income * 0.2)
        }
      };

      if (isSet(a.goal_amount)) {
        const G = amountOf(a.goal_amount, 'goal_amount');
        const C = isSet(a.current_savings) ? toNumber(a.current_savings, 'current_savings') : 0;
        const rate = isSet(a.annual_return) ? rateOf(a.annual_return, 'annual_return', -50, LIMITS.maxRate) : 0;
        if (C < 0 || C > LIMITS.maxAmount) throw new Error('current_savings allowed range mein nahi hai');

        let goal;
        if (C >= G) {
          goal = { goal_amount: formatINR(G), reachable: true, months_needed: 0, years_needed: 0 };
        } else if (surplus <= 0) {
          goal = { goal_amount: formatINR(G), reachable: false, note: 'Abhi surplus nahi hai, isliye goal tak nahi pahunch sakte. Pehle kharcha kam karo ya income badhao.' };
        } else {
          const r = rate / 1200;
          let months;
          if (r === 0) {
            months = (G - C) / surplus;
          } else {
            const A = surplus * (1 + r) / r;
            months = Math.log((G + A) / (C + A)) / Math.log(1 + r);
          }
          months = Math.ceil(months - 1e-9);
          goal = !Number.isFinite(months) || months > LIMITS.maxMonths
            ? { goal_amount: formatINR(G), reachable: false, note: 'Is surplus par goal 100 saal se zyada mein pahunchega.' }
            : {
                goal_amount: formatINR(G),
                reachable: true,
                months_needed: months,
                years_needed: round2(months / 12),
                assumed_return_percent: rate,
                note: 'Estimate hai; returns guaranteed nahi.'
              };
        }
        out.goal = goal;
      }

      return out;
    }
  }
];

function runTool(name, args) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return { error: 'Unknown calculator tool: ' + name };
  try {
    return tool.run(args && typeof args === 'object' ? args : {});
  } catch (e) {
    return { error: e.message || 'Calculation error' };
  }
}

/* ========== 3. intent detection + trusted sources ========== */

const INTENTS = [
  { intent: 'emi', calc: true, re: /\b(emi|loan|installment|instalment)\b/i },
  { intent: 'sip', calc: true, re: /\b(sip|systematic investment)\b/i },
  { intent: 'fd_lumpsum', calc: true, re: /\b(fd|fixed deposit|lump ?sum|maturity)\b/i },
  { intent: 'cagr', calc: true, re: /\bcagr\b|compound annual growth/i },
  { intent: 'simple_interest', calc: true, re: /simple interest|sadharan (byaj|byaaj)|saadhaaran/i },
  { intent: 'gst', calc: true, re: /\bgst\b|goods and services tax/i },
  { intent: 'inflation', calc: true, re: /\binflation\b|meha?ng?ai|महंगाई/i },
  { intent: 'budget', calc: true, re: /\bbudget\b|\bexpenses?\b|monthly income|\bsalary\b|kharcha|kharch\b|bachat|saving plan|बजट|बचत/i },
  { intent: 'tax', calc: false, re: /\b(income tax|itr|tds|80c|old regime|new regime)\b|टैक्स/i },
  { intent: 'rates_rules', calc: false, re: /\b(repo rate|reverse repo|rbi|sebi|ppf|epf|nps|sukanya|ssy|scss|nsc|kisan vikas|fd rates?|current (interest )?rates?)\b|interest rates? (kya|kitn|abhi|today|aaj|currently)|\brates? (kya|kitn[aei]?|abhi|aaj|today|currently)\b|\b(latest|aaj ka|abhi ka) (\w+ )?rates?\b/i }
];

const INTENT_TOOL = {
  emi: 'calc_emi',
  sip: 'calc_sip',
  fd_lumpsum: 'calc_lumpsum',
  cagr: 'calc_cagr',
  simple_interest: 'calc_simple_interest',
  gst: 'calc_gst',
  inflation: 'calc_inflation',
  budget: 'calc_budget',
  compare_emi: 'compare_emi',
  compare_sip: 'compare_sip'
};

const INTENT_LABEL = {
  emi: 'EMI', sip: 'SIP', fd_lumpsum: 'FD/lumpsum', cagr: 'CAGR', simple_interest: 'simple interest',
  gst: 'GST', inflation: 'inflation', budget: 'budget/savings',
  compare_emi: 'EMI comparison', compare_sip: 'SIP scenario comparison'
};

const DISCLAIMERS = {
  emi: 'Actual EMI lender ke rate, fees aur loan terms ke hisaab se alag ho sakti hai.',
  sip: 'SIP returns market par depend karte hain; koi return guaranteed nahi hai.',
  fd_lumpsum: 'Actual maturity bank/NBFC ke rate, compounding aur tax rules par depend kar sakti hai.',
  tax: 'Tax rules badalte rehte hain; official Income Tax portal ya CA se verify karo.',
  rates_rules: 'Rates aur rules badalte rehte hain; bina verified source ke pakka number mat batao.',
  general: 'Yeh general financial information hai, personal financial advice nahi.'
};

function detectFinanceIntents(message) {
  const text = String(message || '').slice(0, 2000);
  return INTENTS.filter(i => i.re.test(text));
}

function detectFinanceIntent(message) {
  const found = detectFinanceIntents(message);
  return found.length ? found[0].intent : 'general';
}

/* ---------- trusted (official) sources ---------- */

const TRUSTED_DOMAINS = Object.freeze([
  'rbi.org.in', 'incometax.gov.in', 'incometaxindia.gov.in', 'sebi.gov.in', 'finmin.gov.in',
  'nsiindia.gov.in', 'indiapost.gov.in', 'gst.gov.in', 'cbic.gov.in', 'epfindia.gov.in', 'pfrda.org.in'
]);

function hostOf(v) {
  const s = String(v || '').trim().toLowerCase();
  const m = s.match(/^(?:https?:\/\/)?([a-z0-9.-]+)(?::\d+)?(?:[\/?#]|$)/);
  return m ? m[1].replace(/^www\./, '') : '';
}

// Gemini grounding chunk (web: {uri, title}) se trusted domain nikalta hai; warna null.
// Exact match ya sub-domain hi chalega ("rbi.org.in.evil.com" nahi).
function trustedDomain(web) {
  if (!web || typeof web !== 'object') return null;
  for (const cand of [web.domain, web.title, web.uri]) {
    const h = hostOf(cand);
    if (!h || !h.includes('.')) continue;
    const hit = TRUSTED_DOMAINS.find(d => h === d || h.endsWith('.' + d));
    if (hit) return hit;
  }
  return null;
}

/* ========== 4. input extraction ========== */

const DEV_DIGITS = '०१२३४५६७८९';

function normalizeText(t, limit = 4000) {
  return String(t || '')
    .slice(0, limit)
    .replace(/[०-९]/g, d => String(DEV_DIGITS.indexOf(d)))
    .replace(/\u00a0/g, ' ');
}

const NUM = '(\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+)';
const RATE_RE = () => new RegExp(NUM + '\\s*(?:%|percent|per\\s*cent|pc(?![a-z])|pct(?![a-z])|pratishat|प्रतिशत)', 'gi');
const YEAR_RE = () => new RegExp(NUM + '\\s*(?:years?|yrs?|saal|sal|varsh|baras|वर्ष|साल)(?![a-z])', 'gi');
const MONTH_RE = () => new RegExp(NUM + '\\s*(?:months?|mahine|mahina|mahin|mnths?|महीने|महीना)(?![a-z])', 'gi');
const AMOUNT_RE = () => new RegExp(
  '(?<![a-z])(?:(₹|rs\\.?|inr)\\s*)?' + NUM + '(?!\\d)' +
  '(?:\\s*(crores?|cr|karod|करोड़|करोड|lakhs?|lacs?|लाख|thousand|hazaar|hajar|हज़ार|हजार|k|l)(?![a-z]))?' +
  '(?:\\s*(rupaye|rupees|rupay|rs)(?![a-z]))?',
  'gi'
);

// "rate 8.5", "interest 9", "@ 8", "gst 18" jaise bina % wale rates
const RATE_WORDS = '(?:rate|dar|byaj|byaaj|vyaj|interest|returns?|roi|gst)';
const IMPLICIT_RATE_RE = () => new RegExp(
  '(?:\\b' + RATE_WORDS + '\\b(?:\\s+(?:rate|dar|of|ka|ki|ke|hai|at|is))*\\s*[:=@]?\\s*|@\\s*)' + NUM +
  '(?!\\d|\\s*(?:crores?|cr|karod|lakhs?|lacs?|thousand|hazaar|hajar|k|l)(?![a-z]))',
  'gi'
);

function unitMult(u) {
  if (!u) return 1;
  const x = u.toLowerCase();
  if (/^(cr|crore|crores|karod|करोड़|करोड)$/.test(x)) return 1e7;
  if (/^(l|lakh|lakhs|lac|lacs|लाख)$/.test(x)) return 1e5;
  return 1e3; // k, thousand, hazaar
}

function collect(re, text) {
  const out = [];
  for (const m of text.matchAll(re)) {
    const value = parseNum(m[1]);
    if (!Number.isFinite(value)) continue;
    out.push({ value, raw: m[0].trim(), index: m.index, end: m.index + m[0].length });
  }
  return out;
}

function maskSpans(text, spans) {
  let out = text;
  for (const s of spans) out = out.slice(0, s.index) + ' '.repeat(s.end - s.index) + out.slice(s.end);
  return out;
}

// Text se saare numbers ko role ke hisaab se alag karta hai:
// rates (% ya "rate 9"), years, months, aur baaki sab amounts.
// Pehle rate/avadhi wale hisse mask hote hain taaki "8.5" ya "20" amount na ban jaye.
function extractFacts(raw, limit) {
  const text = normalizeText(raw, limit);
  const rates = collect(RATE_RE(), text);
  const years = collect(YEAR_RE(), text);
  const months = collect(MONTH_RE(), text);
  let masked = maskSpans(text, [...rates, ...years, ...months]);

  const implicit = [];
  for (const m of masked.matchAll(IMPLICIT_RATE_RE())) {
    const value = parseNum(m[1]);
    if (Number.isFinite(value) && value >= 0 && value <= LIMITS.maxRate) {
      implicit.push({ value, raw: m[0].trim(), index: m.index, end: m.index + m[0].length, implicit: true });
    }
  }
  masked = maskSpans(masked, implicit);

  const amounts = [];
  for (const m of masked.matchAll(AMOUNT_RE())) {
    const base = parseNum(m[2]);
    if (!Number.isFinite(base)) continue;
    const mult = unitMult(m[3]);
    amounts.push({
      value: base * mult,
      mult,
      raw: m[0].trim(),
      numRaw: m[2],
      index: m.index,
      end: m.index + m[0].length,
      marked: Boolean(m[1] || m[3] || m[4]) // ₹ / lakh / k / rupaye jaisa saaf nishaan
    });
  }

  return { text, rates: [...rates, ...implicit].sort((a, b) => a.index - b.index), years, months, amounts };
}

const distinct = vals => [...new Set(vals.map(v => Math.round(v * 1e9) / 1e9))];

// Ek hi amount chahiye ho to: saaf nishaan wala (₹/lakh/k) pehle; warna 100+ ka bina-nishaan number.
// Ek se zyada alag amounts => ambiguous (clarification poochni hai).
function pickSingleAmount(amounts) {
  let pool = amounts.filter(a => a.marked);
  if (!pool.length) {
    pool = amounts.filter(a => a.value >= 100);
    if (pool.length > 1) {
      const noYears = pool.filter(a => !(Number.isInteger(a.value) && a.value >= 1900 && a.value <= 2100 && !/,/.test(a.numRaw)));
      if (noYears.length) pool = noYears;
    }
  }
  const vals = distinct(pool.map(a => a.value));
  if (vals.length === 1) return { value: vals[0] };
  if (vals.length > 1) return { ambiguous: vals };
  return {};
}

// "5 saal 6 mahine" => 66 mahine; warna aakhri saal/mahina jeetta hai ("10 saal ki jagah 15 saal" => 15)
function tenureOf(f) {
  const ys = f.years, ms = f.months;
  if (ys.length === 1 && ms.length === 1 && ms[0].index >= ys[0].end && ms[0].index - ys[0].end <= 12) {
    return { months: Math.round(ys[0].value * 12 + ms[0].value) };
  }
  if (ys.length) return { years: ys[ys.length - 1].value };
  if (ms.length) return { months: ms[ms.length - 1].value };
  return {};
}

const tenureYears = t => (t.years !== undefined ? t.years : t.months !== undefined ? t.months / 12 : undefined);

function yearItems(f) {
  const items = [
    ...f.years.map(y => ({ v: y.value, index: y.index, end: y.end, kind: 'y' })),
    ...f.months.map(m => ({ v: m.value / 12, index: m.index, end: m.end, kind: 'm' }))
  ].sort((a, b) => a.index - b.index);
  const out = [];
  for (let k = 0; k < items.length; k++) {
    const a = items[k], b = items[k + 1];
    if (a.kind === 'y' && b && b.kind === 'm' && b.index - a.end <= 12) { out.push(a.v + b.v); k++; } else out.push(a.v);
  }
  return out;
}

function compoundsOf(text) {
  const t = text.toLowerCase();
  if (/(monthly|mahine\s*wise|masik)\s*compound|compound\w*\s*(monthly|mahine)/.test(t)) return 12;
  if (/half[\s-]*yearly|semi[\s-]*annual|chhamahi/.test(t)) return 2;
  if (/(yearly|annual|saalana|salana)\s*compound|compound\w*\s*(yearly|annually)/.test(t)) return 1;
  if (/daily\s*compound|compound\w*\s*daily/.test(t)) return 365;
  if (/quarterly|tirmahi/.test(t)) return 4;
  return undefined;
}

/* label-based amount assignment (budget, CAGR): label aur number ke beech sabse kam doori wali jodi pehle */

const START_RE = /\b(start(?:ing)?|initial(?:ly)?|shuru\w*|invest(?:ed|ment)?|pehle|beginning|bought|kharida|purchased?|cost)\b/;
const END_RE = /\b(end(?:ing)?|final(?:ly)?|ab|abhi|current(?:ly)?|now|ho\s*gay[ai]|ban\s*gay[ai]|bana|worth|maturity|sold|becha)\b/;
const INCOME_RE = /\b(income|salary|kamai|aamdani|amdani|tankh(?:a|wa)h|vetan|pagar|earning|earn)\b/;
const EXPENSE_RE = /\b(expenses?|kharcha|kharche|kharch|spend(?:ing)?)\b/;
const GOAL_RE = /\b(goal|target|lakshya|chahiye|chahie|collect|jama\s*karna|bachana)\b/;
const SAVED_RE = /\b(current\s*savings?|abhi\s*tak|already|existing|pehle\s*se|saved|jama\s*hai|bachat\s*hai)\b/;
const INCL_RE = /\b(inclusive|included|including|incl|include|shamil|andar)\b/;
const EXCL_RE = /\b(exclusive|excluding|excl|extra|plus|upar|alag\s*se|add|jod\w*|lagana|lagega|lagake)\b/;

function labelAmounts(amounts, text, roles) {
  const low = text.toLowerCase();
  const pairs = [];
  for (const [key, re] of Object.entries(roles)) {
    for (const m of low.matchAll(new RegExp(re.source, 'g'))) {
      const s = m.index, e = m.index + m[0].length;
      amounts.forEach((a, idx) => {
        const gap = e <= a.index ? a.index - e : s >= a.end ? s - a.end : -1;
        if (gap >= 0 && gap <= 24) pairs.push({ key, idx, gap });
      });
    }
  }
  pairs.sort((p, q) => p.gap - q.gap);
  const found = {};
  const used = new Set();
  for (const p of pairs) {
    if (found[p.key] !== undefined || used.has(p.idx)) continue;
    found[p.key] = amounts[p.idx].value;
    used.add(p.idx);
  }
  return { found, rest: amounts.filter((_, idx) => !used.has(idx)) };
}

/* ========== 5. conversation context ("ab 15 saal kar do" jaise follow-ups) ========== */

const FILE_BLOCK_RE = /\[FILE: [^\]\n]{0,120}\][\s\S]*?(?:\[FILE END\]|$)/g;
const stripFiles = t => String(t || '').replace(FILE_BLOCK_RE, ' ');

const FAMILY = i => (i === 'compare_emi' ? 'emi' : i === 'compare_sip' ? 'sip' : i);
const CMP_STRONG = /\b(compare|comparison|tulna|vs\b\.?|versus|farak|fark|antar|difference|behtar|better|kaun\s*sa|konsa)\b/i;
const SCEN_RE = /\b(scenarios?|conservative|moderate|aggressive|best\s*case|worst\s*case|different\s*returns?|alag\s*alag\s*returns?)\b/i;
const REPLACE_RE = /\b(ki\s*jagah|jagah|instead|badal\w*|change|ke\s*bajay|bajay)\b/i;
const FOLLOW_RE = /\b(agar|if|ab|ki\s*jagah|jagah|instead|badal\w*|change|kar\s*do|kardo|kar\s*de|rakh\w*|maan\s*lo|assume|bajay|wahi|usi|same)\b/i;
const RATE_PARAMS = new Set(['annual_rate', 'annual_return', 'gst_rate', 'annual_inflation']);

function newState(intent) {
  return { intent, inputs: {}, ambiguous: [], assumed: false };
}

function transition(state, to) {
  const from = state.intent;
  const i = state.inputs;
  if (from !== to) {
    if (to === 'compare_emi' && isSet(i.months)) { i.years = i.months / 12; delete i.months; }
    if (to === 'emi') { delete i.alt_annual_rate; delete i.alt_years; }
    if (to === 'compare_sip' && isSet(i.annual_return)) {
      if (!isSet(i.moderate_return)) i.moderate_return = i.annual_return;
      delete i.annual_return;
    }
    if (to === 'sip') {
      if (isSet(i.moderate_return)) i.annual_return = i.moderate_return;
      delete i.conservative_return; delete i.moderate_return; delete i.high_return;
    }
  }
  state.intent = to;
}

function pickIntent(text, f, state) {
  let found = detectFinanceIntents(text).filter(i => i.calc).map(i => i.intent);
  // "SIP ka maturity" => sirf SIP (FD nahi)
  if (found.includes('sip') && found.includes('fd_lumpsum') && !/\b(fd|fixed deposit|lump ?sum)\b/i.test(text)) {
    found = found.filter(x => x !== 'fd_lumpsum');
  }
  // "kharcha/expenses/salary" generic shabd hain: aur koi calculator mile to budget chhod do
  if (found.length > 1 && found.includes('budget')) found = found.filter(x => x !== 'budget');
  if (found.length > 1) return 'multi';

  let intent = found[0] || null;
  const nRates = distinct(f.rates.map(r => r.value)).length;
  const nYears = distinct(yearItems(f)).length;
  const replacing = REPLACE_RE.test(text);

  if (intent === 'emi' && (CMP_STRONG.test(text) || (!replacing && (nRates >= 2 || nYears >= 2)))) {
    intent = 'compare_emi';
  } else if (intent === 'sip' && (SCEN_RE.test(text) || CMP_STRONG.test(text) || (!replacing && nRates >= 2))) {
    intent = 'compare_sip';
  } else if (!intent && state && CMP_STRONG.test(text) && ['emi', 'sip'].includes(FAMILY(state.intent))) {
    intent = FAMILY(state.intent) === 'emi' ? 'compare_emi' : 'compare_sip';
  }
  return intent;
}

// Latest message ke numbers ko calculation ke inputs mein daalta hai. Kitne inputs badle, wo count lautata hai.
function applyFacts(state, f) {
  const i = state.inputs;
  let changed = 0;

  const put = (k, v) => {
    if (!Number.isFinite(v)) return;
    i[k] = v;
    state.ambiguous = state.ambiguous.filter(a => a.param !== k);
    changed++;
  };
  const amb = (k, options) => {
    state.ambiguous = state.ambiguous.filter(a => a.param !== k);
    state.ambiguous.push({ param: k, options });
    delete i[k];
    changed++;
  };
  const single = k => {
    const p = pickSingleAmount(f.amounts);
    if (p.value !== undefined) put(k, p.value);
    else if (p.ambiguous) amb(k, p.ambiguous);
  };
  const rate = k => {
    if (f.rates.length) put(k, f.rates[f.rates.length - 1].value);
  };
  const years = k => {
    const y = tenureYears(tenureOf(f));
    if (y !== undefined) put(k, y);
  };

  switch (state.intent) {
    case 'emi': {
      single('principal');
      rate('annual_rate');
      const t = tenureOf(f);
      if (t.years !== undefined) { put('years', t.years); delete i.months; }
      else if (t.months !== undefined) { put('months', t.months); delete i.years; }
      break;
    }
    case 'sip':
      single('monthly_amount'); rate('annual_return'); years('years');
      break;
    case 'fd_lumpsum': {
      single('principal'); rate('annual_rate'); years('years');
      const m = compoundsOf(f.text);
      if (m !== undefined) put('compounds_per_year', m);
      break;
    }
    case 'simple_interest':
      single('principal'); rate('annual_rate'); years('years');
      break;
    case 'inflation':
      single('current_amount'); rate('annual_inflation'); years('years');
      break;
    case 'gst': {
      single('amount'); rate('gst_rate');
      const low = f.text.toLowerCase();
      const inc = INCL_RE.test(low), exc = EXCL_RE.test(low);
      if (inc !== exc) { put('inclusive', inc ? 1 : 0); state.assumed = false; }
      else if (i.inclusive === undefined) { i.inclusive = 0; state.assumed = true; }
      break;
    }
    case 'cagr': {
      const { found, rest } = labelAmounts(f.amounts, f.text, { start_value: START_RE, end_value: END_RE });
      for (const [k, v] of Object.entries(found)) put(k, v);
      const vals = distinct(rest.map(a => a.value));
      const open = ['start_value', 'end_value'].filter(k => found[k] === undefined);
      if (vals.length && open.length) {
        const target = open.filter(k => !isSet(i[k]));
        if (vals.length === target.length) target.forEach((k, n) => put(k, vals[n]));
        else if (vals.length === 2 && open.length === 2) { put('start_value', vals[0]); put('end_value', vals[1]); }
        else amb(open[0], vals);
      }
      years('years');
      break;
    }
    case 'budget': {
      const { found, rest } = labelAmounts(f.amounts, f.text, {
        monthly_income: INCOME_RE, monthly_expenses: EXPENSE_RE, goal_amount: GOAL_RE, current_savings: SAVED_RE
      });
      for (const [k, v] of Object.entries(found)) put(k, v);
      const vals = distinct(rest.map(a => a.value));
      const need = ['monthly_income', 'monthly_expenses'].filter(k => !isSet(i[k]));
      if (vals.length && need.length) {
        if (vals.length === 1 && need.length === 1) put(need[0], vals[0]);
        else amb(need[0], vals);
      }
      rate('annual_return');
      break;
    }
    case 'compare_emi': {
      single('principal');
      const pair = (vals, baseKey, altKey) => {
        if (!vals.length) return;
        if (!isSet(i[baseKey])) {
          put(baseKey, vals[0]);
          if (vals[1] !== undefined) put(altKey, vals[1]);
          return;
        }
        const diff = vals.filter(v => Math.abs(v - i[baseKey]) > 1e-9);
        if (diff.length) put(altKey, diff[diff.length - 1]);
      };
      pair(distinct(f.rates.map(r => r.value)), 'annual_rate', 'alt_annual_rate');
      pair(distinct(yearItems(f)), 'years', 'alt_years');
      break;
    }
    case 'compare_sip': {
      single('monthly_amount'); years('years');
      const rs = distinct(f.rates.map(r => r.value)).sort((a, b) => a - b);
      if (rs.length >= 3) {
        put('conservative_return', rs[0]); put('moderate_return', rs[Math.floor(rs.length / 2)]); put('high_return', rs[rs.length - 1]);
      } else if (rs.length === 2) {
        put('conservative_return', rs[0]); put('high_return', rs[1]); put('moderate_return', round2((rs[0] + rs[1]) / 2));
      } else if (rs.length === 1) {
        put('moderate_return', rs[0]);
      }
      break;
    }
    default:
  }

  return changed;
}

function missingOf(state) {
  const i = state.inputs;
  const miss = [];
  const need = (...ks) => ks.forEach(k => { if (!isSet(i[k])) miss.push(k); });
  switch (state.intent) {
    case 'emi':
      need('principal', 'annual_rate');
      if (!isSet(i.years) && !isSet(i.months)) miss.push('tenure');
      break;
    case 'sip': need('monthly_amount', 'annual_return', 'years'); break;
    case 'fd_lumpsum':
    case 'simple_interest': need('principal', 'annual_rate', 'years'); break;
    case 'cagr': need('start_value', 'end_value', 'years'); break;
    case 'gst': need('amount', 'gst_rate'); break;
    case 'inflation': need('current_amount', 'annual_inflation', 'years'); break;
    case 'budget': need('monthly_income', 'monthly_expenses'); break;
    case 'compare_emi':
      need('principal', 'annual_rate', 'years');
      if (!isSet(i.alt_annual_rate) && !isSet(i.alt_years)) miss.push('alt');
      break;
    case 'compare_sip': need('monthly_amount', 'years'); break;
    default:
  }
  return miss;
}

const wordCount = t => t.trim().split(/\s+/).filter(Boolean).length;
const countKinds = f =>
  (f.amounts.some(a => a.marked || a.value >= 100) ? 1 : 0) + (f.rates.length ? 1 : 0) + (f.years.length || f.months.length ? 1 : 0);

// Bina intent-word wale follow-up: "ab 15 saal kar do", "9% par?", ya assistant ke sawal ka chhota jawab ("20")
function followUp(state, f, text) {
  const words = wordCount(text);
  const explicit = f.rates.length || f.years.length || f.months.length || f.amounts.some(a => a.marked);
  if (explicit) return words <= 12 || FOLLOW_RE.test(text) ? applyFacts(state, f) : 0;

  if (words > 4 || f.amounts.length !== 1) return 0;
  const miss = missingOf(state).filter(k => k !== 'alt');
  if (miss.length !== 1) return 0;

  const v = f.amounts[0].value;
  const k = miss[0];
  const set = (key, val) => {
    state.inputs[key] = val;
    state.ambiguous = state.ambiguous.filter(a => a.param !== key);
    return 1;
  };
  if (k === 'tenure') {
    if (v <= 50) { delete state.inputs.months; return set('years', v); }
    delete state.inputs.years;
    return set('months', v);
  }
  if (RATE_PARAMS.has(k)) return v <= LIMITS.maxRate ? set(k, v) : 0;
  return set(k, v);
}

// messages (user/assistant) se current calculation ka poora context banata hai.
// ctx.fresh    => latest message mein calculation ke naye/badle inputs hain
// ctx.complete => saare zaroori inputs mil gaye aur koi ambiguity nahi
function buildContext(messages) {
  const users = (Array.isArray(messages) ? messages : [])
    .filter(m => m && m.role === 'user' && typeof m.content === 'string');
  let state = null;
  let fresh = false;
  let lastText = '';

  for (const m of users) {
    const text = normalizeText(stripFiles(m.content));
    const f = extractFacts(text);
    lastText = text;
    fresh = false;

    const intent = pickIntent(text, f, state);
    if (intent === 'multi') continue; // ek se zyada calculators => model khud sambhale

    if (intent) {
      const sameFamily = Boolean(state) && FAMILY(state.intent) === FAMILY(intent);
      const follow = sameFamily && (FOLLOW_RE.test(text) || countKinds(f) <= 1 || intent.startsWith('compare'));
      if (follow) transition(state, intent); else state = newState(intent);
      fresh = applyFacts(state, f) > 0;
      continue;
    }

    if (!state || detectFinanceIntents(text).some(x => !x.calc)) continue;
    fresh = followUp(state, f, text) > 0;
  }

  const missing = state ? missingOf(state) : [];
  const ambiguous = state ? state.ambiguous.map(a => ({ param: a.param, options: a.options.slice() })) : [];
  const lastIntents = detectFinanceIntents(lastText);

  return {
    intent: state ? state.intent : null,
    tool: state ? INTENT_TOOL[state.intent] : null,
    inputs: state ? { ...state.inputs } : {},
    missing,
    ambiguous,
    complete: Boolean(state) && !missing.length && !ambiguous.length,
    fresh: Boolean(state) && fresh,
    assumed: Boolean(state && state.assumed),
    needsVerification: lastIntents.some(x => !x.calc),
    intents: lastIntents.map(x => x.intent)
  };
}

function needsVerification(messages) {
  return buildContext(messages).needsVerification;
}

/* ========== 6. readable text (hint, sawal, fallback jawab) ========== */

// [naam, kind, poochne ka tareeka]
const PARAM = {
  principal: ['amount', 'inr', 'loan/investment amount'],
  monthly_amount: ['monthly amount', 'inr', 'mahine ki SIP amount'],
  amount: ['amount', 'inr', 'amount'],
  current_amount: ['aaj ki amount', 'inr', 'aaj ki amount'],
  start_value: ['shuruaati value', 'inr', 'shuruaati value'],
  end_value: ['ant ki value', 'inr', 'ant ki value'],
  monthly_income: ['income', 'inr', 'mahine ki income'],
  monthly_expenses: ['kharcha', 'inr', 'mahine ka kharcha'],
  goal_amount: ['goal', 'inr', 'goal amount'],
  current_savings: ['abhi ki bachat', 'inr', 'abhi tak ki bachat'],
  annual_rate: ['rate', 'pct', 'interest rate (% mein)'],
  annual_return: ['return', 'pct', 'expected annual return (% mein)'],
  gst_rate: ['GST rate', 'pct', 'GST rate (% mein)'],
  annual_inflation: ['inflation', 'pct', 'inflation rate (% mein)'],
  alt_annual_rate: ['doosra rate', 'pct', 'doosra interest rate'],
  conservative_return: ['conservative return', 'pct', 'conservative return'],
  moderate_return: ['moderate return', 'pct', 'moderate return'],
  high_return: ['high return', 'pct', 'high return'],
  years: ['avadhi', 'yrs', 'avadhi (kitne saal)'],
  alt_years: ['doosri avadhi', 'yrs', 'doosri avadhi (saal)'],
  months: ['avadhi', 'mths', 'avadhi (mahine)'],
  tenure: ['avadhi', 'yrs', 'loan ki avadhi (saal ya mahine)'],
  alt: ['', '', 'doosra interest rate ya doosri avadhi (jisse compare karna hai)'],
  compounds_per_year: ['compounding', 'times', 'compounding'],
  inclusive: ['GST', 'incl', 'GST included hai ya extra']
};

function fmtParam(k, v) {
  const kind = (PARAM[k] || [])[1];
  if (kind === 'pct') return v + '%';
  if (kind === 'yrs') return v + ' saal';
  if (kind === 'mths') return v + ' mahine';
  if (kind === 'times') return 'saal mein ' + v + ' baar';
  if (kind === 'incl') return Number(v) === 1 ? 'amount ke andar (included)' : 'amount ke upar se (extra)';
  return formatINR(Number(v));
}

function describeInputs(inputs) {
  return Object.entries(inputs || {})
    .filter(([, v]) => isSet(v) && Number.isFinite(Number(v)))
    .map(([k, v]) => (PARAM[k] ? PARAM[k][0] : k) + ' ' + fmtParam(k, v))
    .join(', ');
}

function askForMissing(ctx) {
  if (!ctx || !ctx.intent) {
    return 'Calculation ke liye amount, rate aur avadhi ke saath apna sawal dobara poochho.';
  }
  const label = INTENT_LABEL[ctx.intent] || 'calculation';
  if (ctx.ambiguous && ctx.ambiguous.length) {
    const a = ctx.ambiguous[0];
    const name = PARAM[a.param] ? PARAM[a.param][0] : a.param;
    return label + ' ke liye "' + name + '" ke liye aapne kai amounts likhe hain (' +
      a.options.map(formatINR).join(', ') + '). Inme se kaunsa sahi hai?';
  }
  const known = describeInputs(ctx.inputs);
  const need = (ctx.missing || []).map(k => (PARAM[k] ? PARAM[k][2] : k));
  return (known ? 'Mujhe ye mil gaya: ' + known + '. ' : '') +
    label + ' nikalne ke liye ab bas ye batao: ' + need.join(', ') + '.';
}

function promptHint(messages) {
  const ctx = buildContext(messages);
  const lines = [];

  if (ctx.intent) {
    const label = INTENT_LABEL[ctx.intent];
    const known = describeInputs(ctx.inputs);
    if (ctx.fresh && ctx.complete) {
      lines.push('Conversation se samjha gaya: ' + label + '. Inputs: ' + known + '.' +
        (ctx.assumed ? ' (GST ke liye "amount ke upar se" maana gaya; user ko ye bata do.)' : '') +
        ' ' + ctx.tool + ' tool inhi inputs ke saath chalao aur sirf tool ke result batao; ye inputs dobara mat poochho.');
    } else if (ctx.fresh && ctx.ambiguous.length) {
      lines.push(label + ' ke inputs mein ek cheez saaf nahi hai: ' + askForMissing(ctx) + ' Sirf yahi ek sawal poochho.');
    } else if (ctx.fresh) {
      const need = ctx.missing.map(k => (PARAM[k] ? PARAM[k][2] : k)).join(', ');
      lines.push(label + ' calculation: ' + (known ? 'mile hue inputs: ' + known + '. ' : '') +
        'Kami: ' + need + '. Sirf kami wale inputs ek hi sawal mein poochho; mile hue inputs dobara mat poochho.');
    } else if (known) {
      lines.push('Pichhle ' + label + ' calculation ke inputs (agar user usi ke baare mein puchhe): ' + known + '.');
    }
  }

  const key = ['tax', 'rates_rules', 'sip', 'emi', 'fd_lumpsum'].find(k => ctx.intents.includes(k));
  if (key) lines.push('Dhyan rakho: ' + DISCLAIMERS[key]);

  return lines.length ? '\n\n' + lines.join('\n') : '';
}

function runContextCalculation(ctx) {
  if (!ctx || !ctx.tool || !ctx.complete) return null;
  const args = { ...ctx.inputs };
  return { name: ctx.tool, args, result: runTool(ctx.tool, args) };
}

const SCEN_LABEL = {
  base: 'Base', alt_rate: 'Doosra rate', alt_tenure: 'Doosri avadhi', alt_rate_and_tenure: 'Doosra rate + avadhi',
  conservative: 'Conservative', moderate: 'Moderate', high: 'High'
};

const RESULT_DISCLAIMER = {
  calc_emi: DISCLAIMERS.emi, compare_emi: DISCLAIMERS.emi,
  calc_sip: DISCLAIMERS.sip, compare_sip: DISCLAIMERS.sip,
  calc_lumpsum: DISCLAIMERS.fd_lumpsum
};

function resultLines(name, args, r) {
  switch (name) {
    case 'calc_emi':
      return ['Monthly EMI: ' + r.monthly_emi, 'Total interest: ' + r.total_interest,
        'Total payment: ' + r.total_payment + ' (' + r.months + ' mahine)'];
    case 'calc_sip':
      return ['Total invest: ' + r.total_invested, 'Estimated future value: ' + r.future_value,
        'Estimated gain: ' + r.estimated_gain];
    case 'calc_lumpsum':
      return ['Maturity amount: ' + r.maturity_amount, 'Interest/gain: ' + r.interest_earned,
        'Compounding: saal mein ' + r.compounds_per_year + ' baar'];
    case 'calc_cagr':
      return ['CAGR: ' + r.cagr_percent + '% per saal'];
    case 'calc_simple_interest':
      return ['Simple interest: ' + r.interest, 'Total amount: ' + r.total_amount];
    case 'calc_gst':
      return ['Base amount: ' + r.base_amount, 'GST: ' + r.gst_amount, 'Total: ' + r.total_amount + ' (' + r.mode + ')'];
    case 'calc_inflation':
      return ['Future kharcha (estimate): ' + r.future_cost_estimate, 'Extra kharcha: ' + r.extra_cost_estimate, r.note];
    case 'compare_emi':
      return ['Loan: ' + r.principal].concat(r.scenarios.map(s =>
        (SCEN_LABEL[s.label] || s.label) + ' (' + s.annual_rate + '%, ' + s.years + ' saal): EMI ' + s.monthly_emi +
        ', total interest ' + s.total_interest +
        (s.label === 'base' ? '' : ' [base se: EMI ' + s.emi_vs_base + ', interest ' + s.interest_vs_base + ']')));
    case 'compare_sip':
      return ['Total invest: ' + r.total_invested].concat(r.scenarios.map(s =>
        (SCEN_LABEL[s.label] || s.label) + ' (' + s.assumed_return_percent + '% assume): future value ' + s.future_value +
        ', gain ' + s.estimated_gain), [r.note]);
    case 'calc_budget': {
      const lines = ['Mahine ka surplus: ' + r.monthly_surplus, 'Savings rate: ' + r.savings_rate_percent + '%',
        '50/30/20 ke hisaab se: needs ' + r.benchmark_50_30_20.needs + ', wants ' + r.benchmark_50_30_20.wants +
        ', savings ' + r.benchmark_50_30_20.savings];
      if (r.goal) {
        if (r.goal.reachable) lines.push('Goal ' + r.goal.goal_amount + ' tak: lagbhag ' + r.goal.months_needed + ' mahine (' + r.goal.years_needed + ' saal)');
        else lines.push('Goal ' + r.goal.goal_amount + ': ' + r.goal.note);
      }
      return lines;
    }
    default:
      return [JSON.stringify(r)];
  }
}

function describeResult(name, args, result) {
  if (!result || result.error) {
    return 'Calculation nahi ho paya: ' + ((result && result.error) || 'unknown error') +
      '. Inputs check karke dobara bataiye.';
  }
  const lines = resultLines(name, args, result);
  if (RESULT_DISCLAIMER[name]) lines.push(RESULT_DISCLAIMER[name]);
  return lines.join('\n');
}

function describeCalls(calls) {
  const ok = (calls || []).filter(c => c && c.result && !c.result.error);
  const notes = new Set();
  const blocks = ok.map(c => {
    if (RESULT_DISCLAIMER[c.name]) notes.add(RESULT_DISCLAIMER[c.name]);
    const head = describeInputs(c.args);
    return (head ? 'Inputs: ' + head + '\n' : '') + resultLines(c.name, c.args, c.result).join('\n');
  });
  return blocks.join('\n\n') + (notes.size ? '\n\n' + [...notes].join('\n') : '');
}

/* ---------- reply verification (naye/fabricated numbers pakadna) ---------- */

function numbersIn(str, out) {
  for (const m of String(str).matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const v = parseNum(m[0]);
    if (Number.isFinite(v)) out.push(Math.abs(v));
  }
}

function walkNumbers(x, out) {
  if (x === null || x === undefined) return;
  if (typeof x === 'number') { if (Number.isFinite(x)) out.push(Math.abs(x)); return; }
  if (typeof x === 'string') { numbersIn(x, out); return; }
  if (Array.isArray(x)) { x.forEach(v => walkNumbers(v, out)); return; }
  if (typeof x === 'object') Object.values(x).forEach(v => walkNumbers(v, out));
}

// Jo numbers reply mein aa sakte hain: tool args/results, user ke numbers (lakh/crore ke saath),
// ctx inputs, pichhle verified jawab, aur inme se kisi do ka fark.
function knownNumbers(calls, texts, ctx, extra) {
  const out = [0];
  for (const c of calls || []) { walkNumbers(c.args, out); walkNumbers(c.result, out); }
  if (ctx && ctx.inputs) walkNumbers(ctx.inputs, out);
  if ((calls || []).some(c => c.name === 'calc_budget')) out.push(50, 30, 20);
  for (const t of [...(texts || []), ...(extra || [])]) {
    numbersIn(t, out);
    for (const a of extractFacts(t, 12000).amounts) out.push(a.value);
  }
  const uniq = [...new Set(out)];
  const all = new Set(uniq);
  const base = uniq.slice(0, 60);
  for (let a = 0; a < base.length; a++) {
    for (let b = a + 1; b < base.length; b++) all.add(Math.abs(base[a] - base[b]));
  }
  // saal/mahine ka seedha gunaa-bhaag (jaise EMI x 12) bhi jaayaz hai
  for (const v of base) { all.add(v * 12); all.add(v / 12); }
  return [...all];
}

// ₹/lakh/k/rupaye wale, comma wale (43,391) ya 5+ digit numbers rupaye ki tarah check hote hain; 2026 jaisa saal nahi.
const checkable = a => a.marked || (/,/.test(a.numRaw) && a.value >= 1000) || (a.value >= 10000 && Number.isInteger(a.value));

function amountKnown(a, known) {
  const dec = (String(a.numRaw).split('.')[1] || '').length;
  // "₹10.2 lakh" jaise gol kiye hue roop ke liye utni chhoot jitna gol karne se hoti hai
  const tol = a.mult > 1 ? 0.5 * Math.pow(10, -dec) * a.mult + 0.51 : a.value < 100 ? 0.011 : 0.51;
  return known.some(k => Math.abs(k - a.value) <= tol);
}

// Model ne tool ko ctx wale inputs ke saath chalaya ya kuch aur (jaise 50 lakh ko 50000 padh liya)?
function inputDiffs(ctx, args) {
  const diffs = [];
  const num = v => { try { return toNumber(v, 'x'); } catch (_) { return NaN; } };
  const months = a => (isSet(a.months) ? num(a.months) : isSet(a.years) ? num(a.years) * 12 : NaN);
  for (const [k, e] of Object.entries(ctx.inputs)) {
    if (ctx.tool === 'calc_emi' && (k === 'years' || k === 'months')) {
      const want = k === 'years' ? e * 12 : e;
      if (!(Math.abs(months(args) - want) <= 0.5)) diffs.push('avadhi: tool mein ' + (isSet(args.months) ? args.months + ' mahine' : args.years + ' saal') + ', user ne ' + describeInputs({ [k]: e }).replace(/^avadhi /, ''));
      continue;
    }
    const got = num(args[k]);
    if (!(Math.abs(got - e) <= 1e-6 * Math.max(1, Math.abs(e)))) {
      diffs.push((PARAM[k] ? PARAM[k][0] : k) + ': tool mein ' + args[k] + ', user ne ' + e);
    }
  }
  return diffs;
}

function toolMismatch(calls, ctx) {
  if (!ctx || !ctx.fresh || !ctx.tool) return [];
  const mine = (calls || []).filter(c => c.name === ctx.tool && c.result && !c.result.error);
  if (!mine.length) return []; // tool chala hi nahi => chat.js ka toolMissing pakadta hai

  // Inputs poore nahi the par model ne tool chala diya => usne kami wale inputs khud guess kiye
  if (!ctx.complete) {
    const alias = { tenure: ['years', 'months'], alt: ['alt_annual_rate', 'alt_years'] };
    const supplied = new Set();
    for (const k of ctx.missing) {
      for (const param of alias[k] || [k]) {
        if (mine.some(c => isSet((c.args || {})[param]))) supplied.add(param);
      }
    }
    return supplied.size ? ['user ne ye diya hi nahi, tool mein guess hua: ' + [...supplied].join(', ')] : [];
  }
  const all = mine.map(c => inputDiffs(ctx, c.args || {}));
  return all.some(d => !d.length) ? [] : all[all.length - 1];
}

// reply ke rupaye/percent numbers known set mein hone chahiye; tool inputs bhi ctx se match hone chahiye.
function verifyReply(text, calls, userTexts, ctx, extraTexts, opts = {}) {
  const known = knownNumbers(calls, userTexts, ctx, extraTexts);
  const facts = extractFacts(text, 12000);
  const unknown = [];

  for (const a of facts.amounts) {
    if (checkable(a) && a.value !== 0 && !amountKnown(a, known)) unknown.push(a.raw);
  }
  for (const r of opts.rates === false ? [] : facts.rates) {
    if (r.implicit) continue;
    if (r.value !== 0 && r.value !== 100 && !known.some(k => Math.abs(k - r.value) < 0.0051)) unknown.push(r.raw);
  }

  const mismatch = toolMismatch(calls, ctx);
  return { ok: !unknown.length && !mismatch.length, unknown: [...new Set(unknown)], mismatch };
}

module.exports = {
  LIMITS,
  TOOLS,
  TRUSTED_DOMAINS,
  DISCLAIMERS,
  runTool,
  formatINR,
  emiNumbers,
  sipNumbers,
  detectFinanceIntent,
  detectFinanceIntents,
  extractFacts,
  buildContext,
  needsVerification,
  promptHint,
  askForMissing,
  runContextCalculation,
  describeInputs,
  describeResult,
  describeCalls,
  verifyReply,
  trustedDomain
};
