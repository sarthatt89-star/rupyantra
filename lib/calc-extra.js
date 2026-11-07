'use strict';

/*
 * Rupeyantra Extra Calculators (lib/calc-extra.js)  --  PHASE 5
 *
 * Naye calculators ka hisaab: FD, RD, step-up SIP, goal SIP, SWP, loan affordability. Sirf hisaab, koi network nahi.
 * Conventions purane SIP calculator jaisi hain: monthly rate = annual/12, SIP ki rakam mahine ki SHURUAT mein jaati hai.
 * Har function ValidationError (name='ValidationError') deta hai agar input galat ho. Result sirf numbers.
 */

const round2 = x => Math.round((x + Number.EPSILON) * 100) / 100;

function bad(msg) {
  const e = new Error('invalid input: ' + msg);
  e.name = 'ValidationError';
  return e;
}
const need = (cond, msg) => { if (!cond) throw bad(msg); };
const monthsOf = a => (a.months !== undefined ? Math.round(a.months) : Math.round(a.years * 12));

// FD: har period par byaj jud kar (cumulative), default timahi (4 baar saal mein)
function fd(a) {
  const m = a.compounds_per_year === undefined ? 4 : a.compounds_per_year;
  need(a.principal > 0 && a.annual_rate >= 0 && a.years > 0 && m >= 1, 'principal, rate, saal aur compounding sahi hone chahiye');
  const maturity = a.principal * Math.pow(1 + a.annual_rate / 100 / m, m * a.years);
  return { maturity_amount: round2(maturity), interest_earned: round2(maturity - a.principal), compounds_per_year: m };
}

// RD: har mahine ki shuruat mein jama, byaj timahi compound (bank ka aam tareeka), har deposit apne bache hue samay tak badhta hai
function rd(a) {
  const n = monthsOf(a);
  need(a.monthly_deposit > 0 && a.annual_rate >= 0 && n >= 1 && n <= 1200, 'deposit, rate aur samay sahi hone chahiye');
  const rq = a.annual_rate / 400;
  let total = 0;
  for (let i = 0; i < n; i++) total += a.monthly_deposit * Math.pow(1 + rq, (n - i) / 3);
  const invested = a.monthly_deposit * n;
  return { total_deposited: round2(invested), maturity_amount: round2(total), interest_earned: round2(total - invested), months: n };
}

// Step-up SIP: har saal SIP ki rakam annual_stepup% badhti hai
function stepupSip(a) {
  need(a.monthly_amount > 0 && a.annual_return >= 0 && a.years > 0 && a.annual_stepup >= 0, 'SIP, return, saal aur step-up sahi hone chahiye');
  const n = Math.round(a.years * 12);
  const r = a.annual_return / 1200;
  let bal = 0, invested = 0;
  for (let i = 0; i < n; i++) {
    const c = a.monthly_amount * Math.pow(1 + a.annual_stepup / 100, Math.floor(i / 12));
    invested += c;
    bal = (bal + c) * (1 + r);
  }
  return { total_invested: round2(invested), future_value: round2(bal), estimated_gain: round2(bal - invested), final_monthly_sip: round2(a.monthly_amount * Math.pow(1 + a.annual_stepup / 100, Math.floor((n - 1) / 12))) };
}

// Goal SIP: goal tak pahunchne ke liye har mahine kitni SIP (seedha formula)
function goalSip(a) {
  need(a.goal_amount > 0 && a.annual_return >= 0 && a.years > 0, 'goal, return aur saal sahi hone chahiye');
  const n = Math.round(a.years * 12);
  const r = a.annual_return / 1200;
  const g = 1 + r;
  const factor = r === 0 ? n : g * (Math.pow(g, n) - 1) / r;
  const sip = a.goal_amount / factor;
  return { required_monthly_sip: round2(sip), total_invested: round2(sip * n), estimated_gain: round2(a.goal_amount - sip * n), months: n };
}

// SWP: corpus se har mahine nikasi; mahine ke end mein pehle byaj/return judta hai, phir nikasi
function swp(a) {
  need(a.corpus > 0 && a.monthly_withdrawal > 0 && a.annual_return >= 0 && a.years > 0, 'corpus, nikasi, return aur saal sahi hone chahiye');
  const n = Math.round(a.years * 12);
  const r = a.annual_return / 1200;
  let bal = a.corpus, withdrawn = 0, lasted = 0, depleted = 0;
  for (let i = 0; i < n; i++) {
    const grown = bal * (1 + r);
    if (grown + 1e-9 < a.monthly_withdrawal) { withdrawn += grown; bal = 0; depleted = 1; break; }
    bal = grown - a.monthly_withdrawal;
    withdrawn += a.monthly_withdrawal;
    lasted++;
  }
  return { total_withdrawn: round2(withdrawn), ending_balance: round2(bal), months_lasted: lasted, depleted, months: n };
}

// Loan affordability: itni EMI mein zyada se zyada kitna loan
function affordability(a) {
  const n = monthsOf(a);
  need(a.monthly_emi > 0 && a.annual_rate >= 0 && n >= 1 && n <= 1200, 'EMI, rate aur samay sahi hone chahiye');
  const r = a.annual_rate / 1200;
  const principal = r === 0 ? a.monthly_emi * n : a.monthly_emi * (1 - Math.pow(1 + r, -n)) / r;
  return { max_principal: round2(principal), total_payment: round2(a.monthly_emi * n), total_interest: round2(a.monthly_emi * n - principal), months: n };
}

module.exports = { fd, rd, stepupSip, goalSip, swp, affordability, round2, monthsOf };
