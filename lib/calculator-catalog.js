'use strict';

/*
 * Rupeyantra Calculator Catalog (lib/calculator-catalog.js)  --  PHASE 5
 *
 * Har calculator ka "kaarkhaane ke bahar" ka chehra: naam, kis category me, form ke fields ke label, result kaise dikhana hai,
 * kaun si official site dekhni chahiye. Hisaab yahan nahi hota: wo engines me hota hai. Naya calculator jodne ke 3 kaam:
 *  1) lib/contracts.js me operation, 2) engine adapter + verifier me hisaab/jaanch, 3) yahan ek entry.
 * 263 calculators isi tarah jude jaayenge (list aane par).  status: 'live' = chalta hai. Baaki 'planned' (UI me nahi dikhta).
 */

const contracts = require('./contracts');
const { forTopics } = require('./sources');

const F = {
  principal: { label: 'Loan / jama ki rakam (₹)', example: 5000000 },
  annual_rate: { label: 'Saalana byaj dar (%)', example: 8.5 },
  years: { label: 'Samay (saal)', example: 20 },
  months: { label: 'Samay (mahine)', example: 240 }
};

const inr = (key, label, extra) => ({ key, label, format: 'inr', ...extra });
const num = (key, label, format = 'number', extra) => ({ key, label, format, ...extra });

const CATALOG = [
  {
    id: 'loan.emi', title: 'EMI Calculator', category: 'Loan', blurb: 'Loan ki mahine ki EMI, kul byaj aur kul bhugtan.',
    fields: { principal: { ...F.principal, label: 'Loan ki rakam (₹)' }, annual_rate: F.annual_rate, years: F.years, months: { ...F.months, label: 'Ya samay (mahine)', optional: true } },
    result: [inr('monthly_emi', 'Monthly EMI', { highlight: true, decimals: 2 }), inr('total_interest', 'Kul byaj', { decimals: 2 }), inr('total_payment', 'Kul bhugtan', { decimals: 2 }), num('months', 'Mahine', 'months')],
    chart: 'loan', sources: ['rbi']
  },
  {
    id: 'loan.prepayment', title: 'Loan Prepayment Calculator', category: 'Loan', blurb: 'Prepayment se kitna byaj bachega aur loan kitna jaldi khatam hoga.',
    fields: {
      principal: { ...F.principal, label: 'Loan ki rakam (₹)' }, annual_rate: F.annual_rate, years: F.years, months: { ...F.months, label: 'Ya samay (mahine)', optional: true },
      annual_prepayment: { label: 'Har saal prepayment (₹)', example: 100000, optional: true }, extra_monthly: { label: 'Har mahine extra (₹)', example: 5000, optional: true }
    },
    result: [inr('interest_saved', 'Byaj ki bachat', { highlight: true, decimals: 2 }), num('months_saved', 'Kitne mahine kam', 'months', { highlight: true }), inr('monthly_emi', 'Monthly EMI (wahi rehti hai)', { decimals: 2 }),
      inr('base_interest', 'Prepayment ke bina kul byaj', { decimals: 2 }), num('base_months', 'Prepayment ke bina mahine', 'months'), inr('new_interest', 'Prepayment ke saath kul byaj', { decimals: 2 }), num('new_months', 'Prepayment ke saath mahine', 'months'), inr('total_prepaid', 'Kul prepayment diya', { decimals: 2 })],
    chart: 'prepayment', sources: ['rbi']
  },
  {
    id: 'loan.affordability', title: 'Loan Affordability', category: 'Loan', blurb: 'Itni EMI me zyada se zyada kitna loan mil sakta hai (anuman).',
    fields: { monthly_emi: { label: 'Kitni EMI de sakte ho (₹/mahina)', example: 30000 }, annual_rate: F.annual_rate, years: F.years, months: { ...F.months, label: 'Ya samay (mahine)', optional: true } },
    result: [inr('max_principal', 'Zyada se zyada loan', { highlight: true, decimals: 2 }), inr('total_interest', 'Kul byaj', { decimals: 2 }), inr('total_payment', 'Kul bhugtan', { decimals: 2 }), num('months', 'Mahine', 'months')],
    chart: null, sources: ['rbi']
  },
  {
    id: 'loan.compare_emi', title: 'EMI Comparison', category: 'Loan', blurb: 'Do rate ya do samay par EMI ka muqabla.',
    fields: { principal: { ...F.principal, label: 'Loan ki rakam (₹)' }, annual_rate: F.annual_rate, years: F.years, alt_annual_rate: { label: 'Doosri byaj dar (%)', example: 9, optional: true }, alt_years: { label: 'Doosra samay (saal)', example: 15, optional: true } },
    result: [inr('principal', 'Loan', { decimals: 0 })],
    table: { key: 'scenarios', columns: [{ key: 'label', label: 'Scenario', format: 'text' }, num('annual_rate', 'Byaj %', 'percent'), num('years', 'Saal'), inr('monthly_emi', 'EMI', { decimals: 0 }), inr('total_interest', 'Kul byaj', { decimals: 0 })] },
    chart: null, sources: ['rbi']
  },
  {
    id: 'invest.sip', title: 'SIP Calculator', category: 'Invest', blurb: 'Har mahine SIP se anumaanit rakam (return pakka nahi hota).',
    fields: { monthly_amount: { label: 'Mahine ki SIP (₹)', example: 10000 }, annual_return: { label: 'Maana hua saalana return (%)', example: 12 }, years: F.years },
    result: [inr('future_value', 'Anumaanit rakam', { highlight: true, decimals: 0 }), inr('total_invested', 'Kul nivesh', { decimals: 0 }), inr('estimated_gain', 'Anumaanit faayda', { decimals: 0 })],
    chart: 'sip', sources: ['sebi', 'amfi']
  },
  {
    id: 'invest.stepup_sip', title: 'Step-up SIP', category: 'Invest', blurb: 'SIP har saal badhti rahe to anumaanit rakam.',
    fields: { monthly_amount: { label: 'Shuruaati SIP (₹/mahina)', example: 10000 }, annual_return: { label: 'Maana hua saalana return (%)', example: 12 }, years: F.years, annual_stepup: { label: 'Har saal SIP kitni badhegi (%)', example: 10 } },
    result: [inr('future_value', 'Anumaanit rakam', { highlight: true, decimals: 0 }), inr('total_invested', 'Kul nivesh', { decimals: 0 }), inr('estimated_gain', 'Anumaanit faayda', { decimals: 0 }), inr('final_monthly_sip', 'Aakhri saal ki SIP', { decimals: 0 })],
    chart: 'stepup', sources: ['sebi', 'amfi']
  },
  {
    id: 'invest.goal_sip', title: 'Goal SIP', category: 'Invest', blurb: 'Goal tak pahunchne ke liye har mahine kitni SIP chahiye (anuman).',
    fields: { goal_amount: { label: 'Goal ki rakam (₹)', example: 10000000 }, annual_return: { label: 'Maana hua saalana return (%)', example: 12 }, years: F.years },
    result: [inr('required_monthly_sip', 'Zaroori monthly SIP', { highlight: true, decimals: 0 }), inr('total_invested', 'Kul nivesh', { decimals: 0 }), inr('estimated_gain', 'Anumaanit faayda', { decimals: 0 })],
    chart: null, sources: ['sebi', 'amfi']
  },
  {
    id: 'invest.compare_sip', title: 'SIP Comparison', category: 'Invest', blurb: 'Teen alag return par SIP ka anuman.',
    fields: { monthly_amount: { label: 'Mahine ki SIP (₹)', example: 10000 }, years: F.years, conservative_return: { label: 'Kam return (%)', example: 6, optional: true }, moderate_return: { label: 'Madhyam return (%)', example: 10, optional: true }, high_return: { label: 'Zyada return (%)', example: 14, optional: true } },
    result: [inr('total_invested', 'Kul nivesh', { decimals: 0 })],
    table: { key: 'scenarios', columns: [{ key: 'label', label: 'Scenario', format: 'text' }, num('assumed_return_percent', 'Return %', 'percent'), inr('future_value', 'Anumaanit rakam', { decimals: 0 }), inr('estimated_gain', 'Faayda', { decimals: 0 })] },
    chart: null, sources: ['sebi', 'amfi']
  },
  {
    id: 'invest.lumpsum', title: 'Lumpsum Calculator', category: 'Invest', blurb: 'Ek baar ke nivesh ka anumaanit maturity.',
    fields: { principal: { label: 'Nivesh ki rakam (₹)', example: 100000 }, annual_rate: { label: 'Maana hua saalana return (%)', example: 7 }, years: F.years, compounds_per_year: { label: 'Saal me kitni baar compound', example: 4, optional: true } },
    result: [inr('maturity_amount', 'Maturity rakam', { highlight: true, decimals: 0 }), inr('interest_earned', 'Faayda', { decimals: 0 })],
    chart: 'growth', sources: ['sebi']
  },
  {
    id: 'invest.fd', title: 'FD Calculator', category: 'Invest', blurb: 'Fixed deposit ka maturity (cumulative, byaj judta jaata hai).',
    fields: { principal: { label: 'FD ki rakam (₹)', example: 100000 }, annual_rate: { label: 'FD ki byaj dar (%)', example: 7 }, years: F.years, compounds_per_year: { label: 'Saal me kitni baar compound (default 4)', example: 4, optional: true } },
    result: [inr('maturity_amount', 'Maturity rakam', { highlight: true, decimals: 2 }), inr('interest_earned', 'Kul byaj', { decimals: 2 })],
    chart: 'growth', sources: ['rbi']
  },
  {
    id: 'invest.rd', title: 'RD Calculator', category: 'Invest', blurb: 'Recurring deposit ka maturity (har mahine jama).',
    fields: { monthly_deposit: { label: 'Mahine ka deposit (₹)', example: 5000 }, annual_rate: { label: 'RD ki byaj dar (%)', example: 6.5 }, years: { ...F.years, optional: true }, months: { ...F.months, label: 'Ya samay (mahine)', optional: true } },
    result: [inr('maturity_amount', 'Maturity rakam', { highlight: true, decimals: 2 }), inr('total_deposited', 'Kul jama', { decimals: 2 }), inr('interest_earned', 'Kul byaj', { decimals: 2 })],
    chart: null, sources: ['indiapost', 'rbi']
  },
  {
    id: 'invest.swp', title: 'SWP Calculator', category: 'Invest', blurb: 'Corpus se har mahine nikasi, aur wo kitne samay chalega (anuman).',
    fields: { corpus: { label: 'Corpus (₹)', example: 5000000 }, monthly_withdrawal: { label: 'Har mahine nikasi (₹)', example: 40000 }, annual_return: { label: 'Maana hua saalana return (%)', example: 8 }, years: F.years },
    result: [num('months_lasted', 'Kitne mahine chala', 'months', { highlight: true }), inr('ending_balance', 'Aakhir me bacha corpus', { decimals: 0 }), inr('total_withdrawn', 'Kul nikasi', { decimals: 0 }), num('depleted', 'Corpus khatam hua?', 'bool')],
    chart: 'swp', sources: ['sebi', 'amfi']
  },
  {
    id: 'invest.cagr', title: 'CAGR Calculator', category: 'Invest', blurb: 'Shuru aur ant ki value se saalana badhat dar.',
    fields: { start_value: { label: 'Shuruaati value (₹)', example: 100000 }, end_value: { label: 'Ab ki value (₹)', example: 200000 }, years: F.years },
    result: [num('cagr_percent', 'CAGR', 'percent', { highlight: true, decimals: 2 })],
    chart: null, sources: ['sebi']
  },
  {
    id: 'interest.simple', title: 'Simple Interest', category: 'Interest', blurb: 'Saadha byaj aur kul rakam.',
    fields: { principal: { ...F.principal, label: 'Rakam (₹)' }, annual_rate: F.annual_rate, years: F.years },
    result: [inr('interest', 'Byaj', { highlight: true, decimals: 2 }), inr('total_amount', 'Kul rakam', { decimals: 2 })],
    chart: null, sources: ['rbi']
  },
  {
    id: 'tax.gst', title: 'GST Calculator', category: 'Tax', blurb: 'GST jodna ya hatana.',
    fields: { amount: { label: 'Rakam (₹)', example: 1000 }, gst_rate: { label: 'GST dar (%)', example: 18 }, inclusive: { label: 'Rakam me GST pehle se shamil hai? (1 = haan, 0 = nahi)', example: 0 } },
    result: [inr('gst_amount', 'GST', { highlight: true, decimals: 2 }), inr('base_amount', 'GST ke bina rakam', { decimals: 2 }), inr('total_amount', 'GST ke saath rakam', { decimals: 2 })],
    chart: null, sources: ['gst']
  },
  {
    id: 'inflation.future_cost', title: 'Inflation Calculator', category: 'Planning', blurb: 'Mehngai se aaj ki rakam ka future kharcha (anuman).',
    fields: { current_amount: { label: 'Aaj ka kharcha (₹)', example: 100000 }, annual_inflation: { label: 'Maani hui saalana mehngai (%)', example: 6 }, years: F.years },
    result: [inr('future_cost', 'Future kharcha', { highlight: true, decimals: 0 }), inr('extra_cost', 'Kitna zyada', { decimals: 0 })],
    chart: null, sources: ['rbi']
  },
  {
    id: 'budget.summary', title: 'Budget Summary', category: 'Planning', blurb: 'Kamai aur kharche se bachat ka haal.',
    fields: { monthly_income: { label: 'Mahine ki kamai (₹)', example: 100000 }, monthly_expenses: { label: 'Mahine ka kharcha (₹)', example: 60000 }, goal_amount: { label: 'Goal ki rakam (₹)', example: 500000, optional: true }, current_savings: { label: 'Abhi ki bachat (₹)', example: 10000, optional: true }, annual_return: { label: 'Maana hua saalana return (%)', example: 8, optional: true } },
    result: [inr('monthly_surplus', 'Mahine ki bachat', { highlight: true, decimals: 0 }), num('savings_rate_percent', 'Bachat dar', 'percent', { decimals: 1 }), num('expense_ratio_percent', 'Kharche ka hissa', 'percent', { decimals: 1 }), { key: 'status', label: 'Haal', format: 'text' }],
    chart: null, sources: ['rbi']
  }
];

const BY_ID = new Map(CATALOG.map(c => [c.id, c]));

function describe(entry) {
  const op = contracts.OPERATIONS[entry.id];
  const fields = Object.entries(op.inputs).map(([name, spec]) => {
    const f = (entry.fields && entry.fields[name]) || {};
    const optional = f.optional === true || (!spec.required && true);
    return {
      name, unit: spec.unit, label: f.label || name, example: f.example === undefined ? null : f.example,
      required: Boolean(spec.required), optional
    };
  });
  return {
    id: entry.id, title: entry.title, category: entry.category, blurb: entry.blurb, status: 'live',
    projection: op.projection, one_of: op.oneOf || [], fields, result: entry.result, table: entry.table || null,
    chart: entry.chart, sources: forTopics(entry.sources || [])
  };
}

const list = () => CATALOG.map(describe);
const get = id => (BY_ID.has(id) ? describe(BY_ID.get(id)) : null);

// Catalog aur contracts hamesha saath rahein: har operation ki entry honi chahiye
function missingEntries() {
  return Object.keys(contracts.OPERATIONS).filter(op => !BY_ID.has(op));
}

module.exports = { list, get, missingEntries, CATALOG };
