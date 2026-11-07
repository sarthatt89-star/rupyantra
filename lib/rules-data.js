'use strict';

/*
 * Rupeyantra Rules Data (lib/rules-data.js)  --  PHASE 7
 *
 * Saal-dar-saal (versioned) niyam ka data: tax slab, GST dar jaisi cheezein. ABHI KHAALI HAI, jaanbujhkar.
 * Sarkari niyam har saal badalte hain aur main bina official source dekhe numbers likh doon to wo galat ho sakte hain.
 * Isliye is file me koi tax dar likhi nahi hai. Data aane par neeche ke format me ek entry jodni hai, aur tabhi use hoga
 * jab saari zaroori fields bhari hon (source, tareekh, kisne verify kiya).
 *
 * Entry ka format (add(entry)):
 *   { topic: 'income_tax_slab', fy: '2026-27', regime: 'new', effective_from: '2026-04-01',
 *     source_url: 'https://www.incometax.gov.in/...', verified_on: '2026-..', verified_by: 'naam',
 *     data: { ...jo bhi numbers } }
 * lookup(topic, fy, regime?) -> { status:'ok', entry } ya { status:'data_not_loaded' }.  Anuman kabhi nahi lagata.
 */

const REQUIRED = ['topic', 'fy', 'effective_from', 'source_url', 'verified_on', 'verified_by', 'data'];

function validateEntry(e) {
  const errors = [];
  if (!e || typeof e !== 'object') return { ok: false, errors: ['entry object honi chahiye'] };
  for (const k of REQUIRED) if (e[k] === undefined || e[k] === null || e[k] === '') errors.push(k + ' zaroori hai');
  if (e.fy !== undefined && !/^\d{4}-\d{2}$/.test(String(e.fy))) errors.push('fy "2026-27" format me ho');
  if (e.effective_from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(e.effective_from))) errors.push('effective_from YYYY-MM-DD ho');
  if (e.verified_on !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(e.verified_on))) errors.push('verified_on YYYY-MM-DD ho');
  if (e.source_url !== undefined && !/^https:\/\/[\w.-]+\.gov\.in(\/|$)/i.test(String(e.source_url)) && !/^https:\/\/[\w.-]+\.nic\.in(\/|$)/i.test(String(e.source_url))) errors.push('source_url sarkari (.gov.in / .nic.in) https link ho');
  if (e.data !== undefined && (typeof e.data !== 'object' || Array.isArray(e.data))) errors.push('data object ho');
  return { ok: errors.length === 0, errors };
}

function createRulesData() {
  const entries = [];
  return {
    add(entry) {
      const v = validateEntry(entry);
      if (!v.ok) throw new Error('rules entry galat: ' + v.errors.join('; '));
      if (entries.some(x => x.topic === entry.topic && x.fy === entry.fy && (x.regime || null) === (entry.regime || null))) throw new Error('is topic/fy/regime ki entry pehle se hai');
      entries.push(JSON.parse(JSON.stringify(entry)));
      return true;
    },
    lookup(topic, fy, regime) {
      const hit = entries.find(x => x.topic === topic && x.fy === fy && (x.regime || null) === (regime || null));
      return hit ? { status: 'ok', entry: JSON.parse(JSON.stringify(hit)) } : { status: 'data_not_loaded', topic, fy, regime: regime || null };
    },
    size: () => entries.length
  };
}

const defaultData = createRulesData();

module.exports = { createRulesData, validateEntry, lookup: defaultData.lookup, add: defaultData.add, size: defaultData.size };
