'use strict';

/*
 * Rupeyantra Calc Chat (lib/calc-chat.js)  --  PHASE 5
 *
 * Chat ke message se naye calculators (FD, RD, step-up SIP, goal SIP, SWP, loan affordability) pehchaanna aur unke inputs nikalna.
 * Sirf fixed niyam (keywords + jo numbers likhe hain). LLM nahi, andaza nahi: jo na mile use "missing" bol kar poochte hain.
 * Naya calculator chat me jodne ke liye yahan ek entry (DEFS) chahiye.
 */

const finance = require('./finance-engine');

const STEP_RE = /\b(step[- ]?up|stepup|badha\w*|increase\w*|increment\w*|hike)\b/i;

// amount: kis role me kaun si field; rates: kaun si rate field; tenure: 'years' ya 'yearsOrMonths'
const DEFS = {
  'invest.fd': {
    detect: /\b(fd|fixed deposit|fixed-deposit)\b/i,
    amounts: ['principal'], rates: ['annual_rate'], tenure: 'years',
    ask: { principal: 'FD ki rakam (jaise 1 lakh)', annual_rate: 'FD ki byaj dar (jaise 7%)', tenure: 'FD kitne saal ki hai' }
  },
  'invest.rd': {
    detect: /\b(rd|recurring deposit|recurring-deposit)\b/i,
    amounts: ['monthly_deposit'], rates: ['annual_rate'], tenure: 'yearsOrMonths',
    ask: { monthly_deposit: 'har mahine kitna deposit (jaise 5000)', annual_rate: 'RD ki byaj dar (jaise 6.5%)', tenure: 'RD kitne saal ya mahine ki hai' }
  },
  'invest.stepup_sip': {
    detect: /\b(step[- ]?up|stepup)\b.*\bsip\b|\bsip\b.*\b(step[- ]?up|stepup|har saal.*(badha|increase)|(badha|increase).*har saal)/i,
    amounts: ['monthly_amount'], rates: ['annual_return', 'annual_stepup'], tenure: 'years', stepRate: true,
    ask: { monthly_amount: 'shuruaati SIP (jaise 10000)', annual_return: 'maana hua saalana return (jaise 12%)', annual_stepup: 'har saal SIP kitni % badhegi (jaise 10%)', tenure: 'kitne saal' }
  },
  'invest.goal_sip': {
    detect: /\b(goal|target|lakshya)\b.*\bsip\b|\bsip\b.*\b(goal|target|lakshya)\b|\bkitni sip\b|\bsip kitni\b|\bkitna sip\b/i,
    amounts: ['goal_amount'], rates: ['annual_return'], tenure: 'years',
    ask: { goal_amount: 'goal ki rakam (jaise 1 crore)', annual_return: 'maana hua saalana return (jaise 12%)', tenure: 'kitne saal me chahiye' }
  },
  'invest.swp': {
    detect: /\b(swp|systematic withdrawal)\b/i,
    amounts: ['corpus', 'monthly_withdrawal'], rates: ['annual_return'], tenure: 'years', amountsOrder: 'desc',
    ask: { corpus: 'corpus (jaise 50 lakh)', monthly_withdrawal: 'har mahine kitni nikasi (jaise 40000)', annual_return: 'maana hua saalana return (jaise 8%)', tenure: 'kitne saal' }
  },
  'loan.affordability': {
    detect: /\b(kitna loan|loan kitna|max(?:imum)? loan|loan eligib\w*|loan afford\w*|afford\w* loan|kitne ka loan)\b/i,
    amounts: ['monthly_emi'], rates: ['annual_rate'], tenure: 'yearsOrMonths',
    ask: { monthly_emi: 'har mahine kitni EMI de sakte ho (jaise 30000)', annual_rate: 'loan ki byaj dar (jaise 8.5%)', tenure: 'loan kitne saal ka' }
  }
};

const OPS = new Set(Object.keys(DEFS));

// Pehla jo mile (order fixed). null = naye calculators me se kuch nahi.
function detect(text) {
  for (const [op, d] of Object.entries(DEFS)) if (d.detect.test(text)) return op;
  return null;
}

function tenureOf(f) {
  if (f.years.length) return { years: f.years[f.years.length - 1].value };
  if (f.months.length) return { months: Math.round(f.months[f.months.length - 1].value) };
  return {};
}

// inherited: pichle (adhoore) inputs. Lautata hai { inputs, missing: [...] }
function build(op, text, inherited = {}) {
  const d = DEFS[op];
  const f = finance.extractFacts(text, 1000);
  const inputs = { ...inherited };

  // rate
  const rates = f.rates.slice();
  if (rates.length) {
    if (d.stepRate) {
      const kw = text.search(STEP_RE);
      const dist = r => Math.abs(r.index - kw);
      let stepRate = null;
      if (kw >= 0) { stepRate = rates.slice().sort((a, b) => dist(a) - dist(b))[0]; }
      if (stepRate && (rates.length > 1 || dist(stepRate) < 25)) {
        inputs.annual_stepup = stepRate.value;
        const other = rates.find(r => r !== stepRate);
        if (other) inputs.annual_return = other.value;
      } else {
        inputs.annual_return = rates[rates.length - 1].value;
      }
    } else {
      inputs[d.rates[0]] = rates[rates.length - 1].value;
    }
  }

  // tenure
  const ten = tenureOf(f);
  if (ten.years !== undefined) { inputs.years = ten.years; delete inputs.months; }
  else if (ten.months !== undefined) {
    if (d.tenure === 'yearsOrMonths') { inputs.months = ten.months; delete inputs.years; }
    else { inputs.years = Math.round(ten.months / 12 * 100) / 100; delete inputs.months; }
  }

  // amounts: jo field abhi khaali hai unme baari-baari
  const pool = f.amounts.filter(a => a.marked || a.value >= 100).slice();
  if (d.amountsOrder === 'desc') pool.sort((a, b) => b.value - a.value);
  const empty = d.amounts.filter(k => inputs[k] === undefined);
  for (let i = 0; i < empty.length && i < pool.length; i++) inputs[empty[i]] = pool[i].value;

  const missing = [];
  for (const k of d.amounts) if (inputs[k] === undefined) missing.push(k);
  for (const k of d.rates) if (inputs[k] === undefined) missing.push(k);
  if (inputs.years === undefined && inputs.months === undefined) missing.push('tenure');
  return { inputs, missing, ask: missing.map(m => d.ask[m]).filter(Boolean) };
}

module.exports = { detect, build, OPS, DEFS };
