'use strict';

/*
 * Rupeyantra Chart Data (lib/chart-data.js)  --  PHASE 6
 *
 * Chart ke liye saal-dar-saal numbers. Hisaab mahine ke loop se, wahi conventions jo engines ki hain. Kuch dikhane ke liye hai:
 * asli jawab engine ka result hai, chart usse milta hona chahiye (tests me jaanchaa jaata hai).
 */

const loanPrepayment = require('./loan-prepayment');

const r2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
const mOf = a => (a.months !== undefined ? Math.round(a.months) : Math.round(a.years * 12));

function chart(title, x, series) {
  return { title, x_label: 'Saal', x, series: series.map(s => ({ name: s.name, values: s.values.map(r2) })) };
}

function loan(a) {
  const n = mOf(a), r = a.annual_rate / 1200;
  const emi = loanPrepayment.emiOf(a.principal, a.annual_rate, n);
  let bal = a.principal, paidInterest = 0;
  const x = [0], balance = [bal], interest = [0];
  for (let m = 1; m <= n; m++) {
    const i = bal * r;
    paidInterest += i;
    bal = Math.max(0, bal + i - emi);
    if (m % 12 === 0 || m === n) { x.push(+(m / 12).toFixed(2)); balance.push(m === n ? 0 : bal); interest.push(paidInterest); }
  }
  return chart('Loan ka bacha hua balance', x, [{ name: 'Bacha hua loan', values: balance }, { name: 'Ab tak diya hua byaj', values: interest }]);
}

function balanceSeries(a, withPre) {
  const n = mOf(a), r = a.annual_rate / 1200;
  const emi = loanPrepayment.emiOf(a.principal, a.annual_rate, n);
  let bal = a.principal;
  const out = [bal];
  for (let m = 1; m <= n; m++) {
    if (bal > 0.005) {
      const i = bal * r;
      const pay = Math.min(emi, bal + i);
      bal = bal + i - pay;
      if (withPre && bal > 0.005 && a.extra_monthly) bal -= Math.min(a.extra_monthly, bal);
      if (withPre && bal > 0.005 && a.annual_prepayment && m % 12 === 0) bal -= Math.min(a.annual_prepayment, bal);
      if (bal <= 0.005) bal = 0;
    }
    if (m % 12 === 0 || m === n) out.push(bal);
  }
  return out;
}

function prepayment(a) {
  const without = balanceSeries(a, false);
  const withPre = balanceSeries(a, true);
  const x = without.map((_, i) => (i === without.length - 1 && mOf(a) % 12 ? +(mOf(a) / 12).toFixed(2) : i));
  return chart('Loan balance: prepayment ke bina aur saath', x, [{ name: 'Prepayment ke bina', values: without }, { name: 'Prepayment ke saath', values: withPre }]);
}

function sip(a) {
  const n = Math.round(a.years * 12), r = a.annual_return / 1200;
  let bal = 0;
  const x = [0], invested = [0], value = [0];
  for (let m = 1; m <= n; m++) {
    bal = (bal + a.monthly_amount) * (1 + r);
    if (m % 12 === 0 || m === n) { x.push(+(m / 12).toFixed(2)); invested.push(a.monthly_amount * m); value.push(bal); }
  }
  return chart('SIP ka anumaanit badhna', x, [{ name: 'Kul nivesh', values: invested }, { name: 'Anumaanit rakam', values: value }]);
}

function stepup(a) {
  const n = Math.round(a.years * 12), r = a.annual_return / 1200;
  let bal = 0, inv = 0;
  const x = [0], invested = [0], value = [0];
  for (let m = 1; m <= n; m++) {
    const c = a.monthly_amount * Math.pow(1 + a.annual_stepup / 100, Math.floor((m - 1) / 12));
    inv += c;
    bal = (bal + c) * (1 + r);
    if (m % 12 === 0 || m === n) { x.push(+(m / 12).toFixed(2)); invested.push(inv); value.push(bal); }
  }
  return chart('Step-up SIP ka anumaanit badhna', x, [{ name: 'Kul nivesh', values: invested }, { name: 'Anumaanit rakam', values: value }]);
}

function growth(a) {
  const m = a.compounds_per_year === undefined ? 4 : a.compounds_per_year;
  const years = Math.ceil(a.years);
  const x = [], value = [], principal = [];
  for (let y = 0; y <= years; y++) {
    const t = Math.min(y, a.years);
    x.push(+(t).toFixed(2));
    value.push(a.principal * Math.pow(1 + a.annual_rate / 100 / m, m * t));
    principal.push(a.principal);
    if (t === a.years) break;
  }
  return chart('Nivesh ka anumaanit badhna', x, [{ name: 'Lagayi hui rakam', values: principal }, { name: 'Anumaanit rakam', values: value }]);
}

function swp(a) {
  const n = Math.round(a.years * 12), r = a.annual_return / 1200;
  let bal = a.corpus;
  const x = [0], values = [bal];
  for (let m = 1; m <= n; m++) {
    if (bal > 0) {
      const g = bal * (1 + r);
      bal = g < a.monthly_withdrawal ? 0 : g - a.monthly_withdrawal;
    }
    if (m % 12 === 0 || m === n) { x.push(+(m / 12).toFixed(2)); values.push(bal); }
  }
  return chart('Corpus ka bacha hua balance', x, [{ name: 'Bacha hua corpus', values }]);
}

const KINDS = { loan, prepayment, sip, stepup, growth, swp };

// kind catalog ka chart naam hai; inputs wahi task ke inputs. Kuch na ho to null.
function build(kind, inputs) {
  const fn = KINDS[kind];
  if (!fn) return null;
  try { return fn(inputs); } catch (_) { return null; }
}

module.exports = { build, KINDS };
