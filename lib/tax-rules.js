'use strict';

/*
 * Income tax rules used by calc_income_tax (lib/cpp-tools.js).
 * Slab format: [upper limit of the slab, rate %]; the last slab is unlimited (its limit is ignored).
 * Surcharge format: [income above, surcharge %].
 *
 * Checked on 2026-10-31 against incometaxindia.gov.in tax-rate pages (slabs, 87A rebate, surcharge)
 * and several tax-portal write-ups that agree with them. Budget 2026 (1 Feb 2026) did not change slabs.
 * When rules change, edit ONLY this file (and the dates), then run npm test.
 */

const RULES = {
  fy: '2026-27',
  ay: '2027-28',
  checked_on: '2026-10-31',
  valid_until: '2027-03-31',
  scope: 'Resident individual below 60 years, normal slab income only (capital gains and other special-rate income are not included).',
  sources: [
    'https://incometaxindia.gov.in/Documents/Left%20Menu/TAX%20RATES_Indvl.htm',
    'https://incometaxindia.gov.in/Charts%20%20Tables/Tax-rates-for-last-10-years/Individual-and-HUFs-Tax%20Rates.html',
    'https://www.incometaxindia.gov.in/w/threshold-limits-under-income-tax-act'
  ],
  new: {
    label: 'New regime (Section 115BAC, default)',
    standard_deduction: 75000,
    allows_deductions: false,
    slabs: [[400000, 0], [800000, 5], [1200000, 10], [1600000, 15], [2000000, 20], [2400000, 25], [0, 30]],
    rebate_limit: 1200000,
    rebate_max: 60000,
    rebate_relief: 1,
    surcharge: [[5000000, 10], [10000000, 15], [20000000, 25]],
    cess: 4
  },
  old: {
    label: 'Old regime',
    standard_deduction: 50000,
    allows_deductions: true,
    slabs: [[250000, 0], [500000, 5], [1000000, 20], [0, 30]],
    rebate_limit: 500000,
    rebate_max: 12500,
    rebate_relief: 0,
    surcharge: [[5000000, 10], [10000000, 15], [20000000, 25], [50000000, 37]],
    cess: 4
  }
};

module.exports = RULES;
