'use strict';

/*
 * Rupeyantra Official Sources (lib/sources.js)  --  PHASE 7
 *
 * Kis topic ke liye kaun si OFFICIAL website dekhni chahiye. Sirf sarkari/regulator ki mukhya website (homepage) ka link.
 * Dhyan: ye mukhya site ka pata hai. Kisi khaas niyam, rate ya tareekh ka pakka page yahan verify nahi kiya gaya; jahan niyam
 * ka data chahiye wahan lib/rules-data.js ke versioned data par jaana hoga (jo abhi khaali hai).
 */

const SOURCES = Object.freeze({
  rbi: { id: 'rbi', name: 'Reserve Bank of India', url: 'https://www.rbi.org.in', topics: ['loan', 'repo', 'interest', 'banking'] },
  sebi: { id: 'sebi', name: 'SEBI', url: 'https://www.sebi.gov.in', topics: ['mutual_fund', 'sip', 'investment'] },
  amfi: { id: 'amfi', name: 'AMFI India', url: 'https://www.amfiindia.com', topics: ['mutual_fund', 'sip', 'nav'] },
  incometax: { id: 'incometax', name: 'Income Tax Department', url: 'https://www.incometax.gov.in', topics: ['income_tax', 'tds'] },
  gst: { id: 'gst', name: 'GST Portal', url: 'https://www.gst.gov.in', topics: ['gst'] },
  indiapost: { id: 'indiapost', name: 'India Post', url: 'https://www.indiapost.gov.in', topics: ['rd', 'savings_schemes'] },
  epfo: { id: 'epfo', name: 'EPFO', url: 'https://www.epfindia.gov.in', topics: ['epf', 'pf'] },
  npstrust: { id: 'npstrust', name: 'NPS Trust', url: 'https://www.npstrust.org.in', topics: ['nps'] }
});

const forTopics = ids => ids.map(id => SOURCES[id]).filter(Boolean).map(s => ({ id: s.id, name: s.name, url: s.url }));

module.exports = { SOURCES, forTopics };
