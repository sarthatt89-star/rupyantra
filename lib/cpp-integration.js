'use strict';

/*
 * Rupeyantra C++ integration (lib/cpp-integration.js)
 *
 * One call - require('../lib/cpp-integration').install() in api/chat.js - plugs the C++ tools into the
 * existing system WITHOUT editing finance-engine.js, finance-validator.js or intent-router.js:
 *   - adds the tools from lib/cpp-tools.js to engine.TOOLS (chat.js builds its tool list from that array)
 *   - understands simulation / prepayment / tax / rate-table questions (conversation context, follow-ups)
 *   - makes the validator re-check the new tools with separate JS code
 *   - makes the router ask for missing inputs directly (no AI call) or hand a ready tool to the AI
 * Everything else passes through to the original functions untouched. install() never throws; if it cannot
 * install, the site behaves exactly as before. To remove the feature, delete the one line in api/chat.js.
 */

const tools = require('./cpp-tools');

const FILE_RE = /\[FILE: [^\]\n]{0,120}\][\s\S]*?(?:\[FILE END\]|$)/g;
const DEV = '०१२३४५६७८९';

const TOOL_OF = {
  sim_sip: 'calc_sip_simulation',
  sim_lumpsum: 'calc_lumpsum_simulation',
  prepay: 'calc_loan_prepayment',
  tax_calc: 'calc_income_tax',
  rate_table: 'calc_emi_rate_table'
};

const LABEL = {
  sim_sip: 'SIP simulation',
  sim_lumpsum: 'lumpsum simulation',
  prepay: 'loan prepayment',
  tax_calc: 'income tax',
  rate_table: 'EMI rate table'
};

/* ========== text -> numbers ========== */

function normalize(raw) {
  return String(raw || '').slice(0, 4000)
    .replace(FILE_RE, ' ')
    .replace(/[०-९]/g, d => String(DEV.indexOf(d)))
    .replace(/\u00a0/g, ' ')
    .replace(/(\d)\s*lpa\b/gi, '$1 lakh')
    .toLowerCase()
    .replace(/\b80([a-z]{1,5})\b/g, 'section_$1'); // tax sections (80c, 80d ...) are not amounts
}

const NUM = '(\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+)';
const parseNum = s => Number(String(s).replace(/,/g, ''));
const RATE_RE = () => new RegExp(NUM + '\\s*(?:%|percent|per\\s*cent|pratishat|प्रतिशत)', 'g');
const YEAR_RE = () => new RegExp(NUM + '\\s*(?:years?|yrs?|saal|sal|varsh|baras|वर्ष|साल)(?![a-z])', 'g');
const MONTH_RE = () => new RegExp(NUM + '\\s*(?:months?|mahine|mahina|mahin|महीने|महीना)(?![a-z])', 'g');
const AMOUNT_RE = () => new RegExp(
  '(?<![a-z])(?:(₹|rs\\.?|inr)\\s*)?' + NUM + '(?!\\d)' +
  '(?:\\s*(crores?|cr|karod|करोड़|करोड|lakhs?|lacs?|लाख|thousand|hazaar|hajar|हज़ार|हजार|k|l)(?![a-z]))?' +
  '(?:\\s*(rupaye|rupees|rupay|rs)(?![a-z]))?', 'g');
const IMPLICIT_RATE_RE = () => new RegExp(
  '\\b(?:rate|dar|byaj|interest|returns?|roi|volatility|vol|risk)\\b(?:\\s+(?:of|ka|ki|ke|hai|at|is))*\\s*[:=@]?\\s*' + NUM +
  '(?!\\d|\\s*(?:crores?|cr|karod|lakhs?|lacs?|thousand|hazaar|hajar|k|l|saal|years?|mahine|months?)(?![a-z]))', 'g');
const AFTER_RE = () => new RegExp(
  '(?:after|baad)\\s*' + NUM + '\\s*(years?|saal|sal|months?|mahine|mahina)(?![a-z])|' +
  NUM + '\\s*(years?|saal|sal|months?|mahine|mahina)\\s*(?:ke\\s*baad|baad|after)', 'g');

function collect(re, text) {
  const out = [];
  for (const m of text.matchAll(re)) {
    const value = parseNum(m[1]);
    if (Number.isFinite(value)) out.push({ value, index: m.index, end: m.index + m[0].length });
  }
  return out;
}

function mask(text, spans) {
  let out = text;
  for (const s of spans) out = out.slice(0, s.index) + ' '.repeat(s.end - s.index) + out.slice(s.end);
  return out;
}

function unitMult(u) {
  if (!u) return 1;
  if (/^(cr|crore|crores|karod|करोड़|करोड)$/.test(u)) return 1e7;
  if (/^(l|lakh|lakhs|lac|lacs|लाख)$/.test(u)) return 1e5;
  return 1e3;
}

function parseFacts(text) {
  const rates = collect(RATE_RE(), text);
  const years = collect(YEAR_RE(), text);
  const months = collect(MONTH_RE(), text);
  let masked = mask(text, [...rates, ...years, ...months]);

  const implicit = collect(IMPLICIT_RATE_RE(), masked).filter(x => x.value >= 0 && x.value <= 100);
  masked = mask(masked, implicit);

  const amounts = [];
  for (const m of masked.matchAll(AMOUNT_RE())) {
    const base = parseNum(m[2]);
    if (!Number.isFinite(base)) continue;
    const mult = unitMult(m[3]);
    amounts.push({
      value: base * mult, index: m.index, end: m.index + m[0].length,
      marked: Boolean(m[1] || m[3] || m[4]), numRaw: m[2]
    });
  }
  return { text, rates: [...rates, ...implicit].sort((a, b) => a.index - b.index), years, months, amounts };
}

const distinct = vals => [...new Set(vals.map(v => Math.round(v * 1e9) / 1e9))];

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

function tenureYears(f) {
  const ys = f.years, ms = f.months;
  if (ys.length === 1 && ms.length === 1 && ms[0].index >= ys[0].end && ms[0].index - ys[0].end <= 12) return ys[0].value + ms[0].value / 12;
  if (ys.length) return ys[ys.length - 1].value;
  if (ms.length) return ms[ms.length - 1].value / 12;
  return undefined;
}

// nearest label wins: gap between a label word and a number must be <= 24 characters
function label(items, text, roles) {
  const pairs = [];
  for (const [key, re] of Object.entries(roles)) {
    for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
      const s = m.index, e = m.index + m[0].length;
      items.forEach((it, idx) => {
        const gap = e <= it.index ? it.index - e : s >= it.end ? s - it.end : -1;
        if (gap >= 0 && gap <= 24) pairs.push({ key, idx, gap });
      });
    }
  }
  pairs.sort((p, q) => p.gap - q.gap);
  const found = {};
  const used = new Set();
  for (const p of pairs) {
    if (found[p.key] !== undefined || used.has(p.idx)) continue;
    found[p.key] = items[p.idx];
    used.add(p.idx);
  }
  return { found, rest: items.filter((_, i) => !used.has(i)) };
}

/* ========== which intent is this message? ========== */

const CONCEPT_RE = /\b(?:kya\s+(?:hai|hota|hoti|hote|matlab)|what\s+is|what\s+does|meaning|explain|samjha\w*)\b/;
const SIM_RE = /\b(?:simulat\w*|monte[\s-]?carlo|worst[\s-]?case|best[\s-]?case|expected[\s-]?case|scenarios?|probabilit\w*|sambhavna|chances?|volatil\w*|utar[\s-]?chadhav)\b/;
const SIP_RE = /\b(?:sip|systematic|mutual\s*funds?)\b/;
const MONTHLY_RE = /\b(?:har\s*mahine|every\s*month|per\s*month|monthly|each\s*month|mahine\s*mein|mahine\s*ke)\b/;
const LUMPW_RE = /\b(?:lump\s*sum|lumpsum|ek\s*saath|ek\s*baar|one[\s-]?time|bonus|part[\s-]?payment|foreclos\w*)\b/;
const INVEST_RE = /\b(?:invest\w*|fd|fixed\s*deposit|deposit|lump\s*sum|lumpsum)\b/;
const LOANW_RE = /\b(?:loan|emi|karz|karza|home\s*loan|car\s*loan)\b/;
const PREPAY_RE = /\b(?:prepay\w*|pre[\s-]?payment|part[\s-]?payment|foreclos\w*|extra\s*emi|extra\s*payment|early\s*(?:repay\w*|closure)|jaldi\s*chuka\w*|loan\s*jaldi)\b/;
const EXTRA_RE = /\b(?:extra|zyada)\b/;
const TAXW_RE = /\b(?:income\s*tax|tax)\b/;
const REGIMEW_RE = /\b(?:old|new|purana|naya)\s*(?:tax\s*)?regime\b/;
const TAXCALC_RE = /\b(?:kitna|kitni|calculate|calculation|nikalo|nikal|nikalna|lagega|lagegi|lagta|payable|liability|bharna|compute|how\s*much|batao|bata|compare)\b/;
const INCOME_W = /\b(?:income|salary|kamai|aay|earning|earns?|ctc|package|tankhwah|vetan|pagar|annual|saalana)\b/;
const TABLE_RE = /\b(?:table|chart|har\s*rate|sabhi\s*rates?|alag[\s-]?alag\s*(?:rate|byaj|interest)s?|different\s*(?:rates?|interest)|sweep|rates?\s*ka\s*(?:asar|farak|effect))\b/;
const RANGE_RE = /(\d+(?:\.\d+)?)\s*%?\s*(?:se|to|-|–)\s*(\d+(?:\.\d+)?)\s*%/;
const GOAL_RE = /\b(?:goal|target|lakshya|chahiye|chahie|banana|pahunch\w*|reach|achieve|collect|jama)\b/;
const VOL_RE = /\b(?:volatil\w*|vol|utar[\s-]?chadhav|uthal[\s-]?puthal|risk|std|standard\s*deviation)\b/;
const LOANAMT_RE = /\b(?:loan|karz|karza|principal|home\s*loan|car\s*loan)\b/;
const DED_RE = /\b(?:deduction\w*|section_\w+|nps|hra|home\s*loan\s*interest|investments?|declare\w*|ppf|elss|insurance)\b/;
const MONTHLYINC_RE = /\b(?:per\s*month|monthly|har\s*mahine|mahine\s*ka|mahina|a\s*month)\b/;
const ANNUALINC_RE = /\b(?:annual|yearly|per\s*year|saal\s*ka|saalana|ctc|package|lpa|per\s*annum|p\.?a\.?)\b/;
const FOLLOW_RE = /\b(?:agar|if|ab|ki\s*jagah|jagah|instead|badal\w*|change|kar\s*do|kardo|kar\s*de|rakh\w*|maan\s*lo|assume|bajay|wahi|usi|same)\b/;

const hasMoney = f => f.amounts.some(a => a.marked || a.value >= 1000);

function detectIntent(text, f) {
  if (!/\d/.test(text)) return null;
  if (CONCEPT_RE.test(text) && !f.rates.length && !f.amounts.some(a => a.marked)) return null;

  if ((TAXW_RE.test(text) || REGIMEW_RE.test(text)) && (TAXCALC_RE.test(text) || REGIMEW_RE.test(text)) &&
      (INCOME_W.test(text) || /\btax\s+(?:on|par|for)\b/.test(text)) && hasMoney(f)) return 'tax_calc';

  const prepay = PREPAY_RE.test(text) || (LOANW_RE.test(text) && EXTRA_RE.test(text));
  if (prepay && f.amounts.length) return 'prepay';

  if (LOANW_RE.test(text) && (TABLE_RE.test(text) || RANGE_RE.test(text)) &&
      distinct(f.rates.map(r => r.value)).length >= 2) return 'rate_table';

  if (SIM_RE.test(text) && f.amounts.length) {
    if (SIP_RE.test(text) || MONTHLY_RE.test(text)) return 'sim_sip';
    if (INVEST_RE.test(text)) return 'sim_lumpsum';
  }
  return null;
}

/* ========== conversation state ========== */

const newState = intent => ({ intent, inputs: {}, ambiguous: [], assumed: false });

function setter(state) {
  let puts = 0;
  return {
    put(k, v) {
      if (!Number.isFinite(v)) return;
      state.inputs[k] = v;
      state.ambiguous = state.ambiguous.filter(a => a.param !== k && !(a.param === 'prepay_type' && (k === 'extra_monthly' || k === 'lump_sum')));
      puts++;
    },
    amb(param, options, extra) {
      state.ambiguous = state.ambiguous.filter(a => a.param !== param);
      state.ambiguous.push(Object.assign({ param, options }, extra || {}));
      delete state.inputs[param];
      puts++;
    },
    single(amounts, k) {
      const p = pickSingleAmount(amounts);
      if (p.value !== undefined) this.put(k, p.value);
      else if (p.ambiguous) this.amb(k, p.ambiguous);
    },
    get puts() { return puts; }
  };
}

function returnAndVol(f, text, s) {
  const lab = label(f.rates, text, { annual_volatility: VOL_RE });
  if (lab.found.annual_volatility) s.put('annual_volatility', lab.found.annual_volatility.value);
  const rest = lab.rest;
  if (rest.length >= 2 && !lab.found.annual_volatility) {
    s.put('annual_return', rest[0].value);
    s.put('annual_volatility', rest[1].value);
  } else if (rest.length) {
    s.put('annual_return', rest[0].value);
  }
}

function applyText(state, text) {
  const s = setter(state);
  const i = state.inputs;

  switch (state.intent) {
    case 'sim_sip': {
      const f = parseFacts(text);
      const lab = label(f.amounts, text, { goal_amount: GOAL_RE });
      if (lab.found.goal_amount) s.put('goal_amount', lab.found.goal_amount.value);
      s.single(lab.rest, 'monthly_amount');
      returnAndVol(f, text, s);
      const y = tenureYears(f);
      if (y !== undefined) s.put('years', y);
      break;
    }
    case 'sim_lumpsum': {
      const f = parseFacts(text);
      s.single(f.amounts, 'principal');
      returnAndVol(f, text, s);
      const y = tenureYears(f);
      if (y !== undefined) s.put('years', y);
      break;
    }
    case 'prepay': {
      let t = text;
      const afterSpans = [];
      let afterMonths;
      for (const m of t.matchAll(AFTER_RE())) {
        const value = parseNum(m[1] !== undefined ? m[1] : m[3]);
        const unit = m[1] !== undefined ? m[2] : m[4];
        afterSpans.push({ index: m.index, end: m.index + m[0].length });
        afterMonths = /^(y|s)/.test(unit) ? Math.round(value * 12) : Math.round(value);
      }
      t = mask(t, afterSpans);
      const f = parseFacts(t);

      if (f.rates.length) s.put('annual_rate', f.rates[f.rates.length - 1].value);
      const y = tenureYears(f);
      if (y !== undefined) s.put('years', y);

      const loanLab = label(f.amounts, t, { principal: LOANAMT_RE });
      let rest = loanLab.rest;
      if (loanLab.found.principal) {
        s.put('principal', loanLab.found.principal.value);
      } else if (i.principal === undefined) {
        if (f.amounts.length >= 2) {
          const big = f.amounts.reduce((a, b) => (b.value > a.value ? b : a));
          s.put('principal', big.value);
          rest = f.amounts.filter(a => a !== big);
        } else if (f.amounts.length === 1) {
          s.put('principal', f.amounts[0].value);
          rest = [];
        }
      }

      const lab2 = label(rest, t, { extra_monthly: MONTHLY_RE, lump_sum: LUMPW_RE });
      if (lab2.found.extra_monthly) s.put('extra_monthly', lab2.found.extra_monthly.value);
      if (lab2.found.lump_sum) s.put('lump_sum', lab2.found.lump_sum.value);
      if (lab2.rest.length === 1 && !lab2.found.extra_monthly && !lab2.found.lump_sum) {
        const amount = lab2.rest[0].value;
        const m = MONTHLY_RE.test(t), l = LUMPW_RE.test(t);
        if (m && !l) s.put('extra_monthly', amount);
        else if (l && !m) s.put('lump_sum', amount);
        else s.amb('prepay_type', ['har mahine', 'ek saath'], { amount });
      }
      if (afterMonths !== undefined) s.put('lump_after_month', afterMonths);
      break;
    }
    case 'tax_calc': {
      const f = parseFacts(text);
      const lab = label(f.amounts, text, { deductions: DED_RE });
      if (lab.found.deductions) s.put('deductions', lab.found.deductions.value);
      const p = pickSingleAmount(lab.rest);
      if (p.value !== undefined) {
        const monthly = MONTHLYINC_RE.test(text) && !ANNUALINC_RE.test(text);
        s.put('annual_income', monthly ? p.value * 12 : p.value);
        if (monthly) state.assumed = true;
      } else if (p.ambiguous) {
        s.amb('annual_income', p.ambiguous);
      }
      const both = (/\bold\b|purana/.test(text) && /\bnew\b|naya/.test(text)) || /\b(?:compare|dono|vs|versus|better|behtar|kaun\s*sa|konsa|which)\b/.test(text);
      if (both) s.put('regime', 3);
      else if (/\bold\b|purana/.test(text)) s.put('regime', 2);
      else if (/\bnew\b|naya/.test(text)) s.put('regime', 1);
      break;
    }
    case 'rate_table': {
      let t = text;
      const stepRes = [
        new RegExp('\\b(?:step|interval|gap)\\s*(?:of|ka|ke|=|:)?\\s*' + NUM + '\\s*%?', 'g'),
        new RegExp(NUM + '\\s*%?\\s*(?:ke\\s*)?(?:step|gap|interval)', 'g')
      ];
      for (const re of stepRes) {
        const found = collect(re, t);
        if (found.length) {
          s.put('step', found[found.length - 1].value);
          t = mask(t, found);
        }
      }
      const f = parseFacts(t);
      s.single(f.amounts, 'principal');
      const rs = distinct(f.rates.map(r => r.value)).sort((a, b) => a - b);
      if (rs.length >= 2) {
        s.put('rate_from', rs[0]);
        s.put('rate_to', rs[rs.length - 1]);
      }
      const y = tenureYears(f);
      if (y !== undefined) s.put('years', y);
      break;
    }
    default:
  }
  return s.puts;
}

function missingOf(state) {
  const i = state.inputs;
  const miss = [];
  const need = (...ks) => ks.forEach(k => { if (i[k] === undefined && !state.ambiguous.some(a => a.param === k)) miss.push(k); });
  switch (state.intent) {
    case 'sim_sip': need('monthly_amount', 'annual_return', 'years'); break;
    case 'sim_lumpsum': need('principal', 'annual_return', 'years'); break;
    case 'prepay':
      need('principal', 'annual_rate', 'years');
      if (i.extra_monthly === undefined && i.lump_sum === undefined && !state.ambiguous.some(a => a.param === 'prepay_type')) miss.push('prepay');
      if (i.lump_sum !== undefined && i.lump_after_month === undefined) miss.push('lump_after_month');
      break;
    case 'tax_calc': need('annual_income'); break;
    case 'rate_table': need('principal', 'years', 'rate_from', 'rate_to'); break;
    default:
  }
  return miss;
}

function followUp(state, text) {
  const pending = state.ambiguous.find(a => a.param === 'prepay_type');
  if (pending) {
    const m = MONTHLY_RE.test(text), l = LUMPW_RE.test(text);
    if (m !== l) {
      const s = setter(state);
      s.put(m ? 'extra_monthly' : 'lump_sum', pending.amount);
      return s.puts;
    }
  }

  const f = parseFacts(text);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const explicit = f.rates.length || f.years.length || f.months.length || f.amounts.some(a => a.marked);
  if (explicit) return words <= 14 || FOLLOW_RE.test(text) ? applyText(state, text) : 0;

  if (words > 4 || f.amounts.length !== 1) return 0;
  const miss = missingOf(state);
  if (miss.length !== 1 || miss[0] === 'prepay') return 0;
  const v = f.amounts[0].value;
  const k = miss[0];
  const isPct = ['annual_rate', 'annual_return', 'rate_from', 'rate_to'].includes(k);
  if ((isPct || k === 'years') && v > 100) return 0;
  const s = setter(state);
  s.put(k, v);
  return s.puts;
}

function toCtx(state, fresh) {
  const missing = missingOf(state);
  const ambiguous = state.ambiguous.map(a => ({ param: a.param, options: a.options.slice(), amount: a.amount }));
  return {
    _cpp: true,
    intent: state.intent,
    tool: TOOL_OF[state.intent],
    inputs: Object.assign({}, state.inputs),
    missing,
    ambiguous,
    complete: !missing.length && !ambiguous.length,
    fresh: Boolean(fresh),
    assumed: state.assumed,
    needsVerification: state.intent === 'tax_calc',
    intents: [state.intent]
  };
}

// otherCalc(text) => true when the message is a different calculator question (handled by the original engine)
function cppContext(messages, otherCalc) {
  const users = (Array.isArray(messages) ? messages : []).filter(m => m && m.role === 'user' && typeof m.content === 'string');
  let state = null;
  let fresh = false;

  for (const m of users) {
    const text = normalize(m.content);
    const intent = detectIntent(text, parseFacts(text));
    fresh = false;

    if (intent) {
      if (!state || state.intent !== intent) state = newState(intent);
      fresh = applyText(state, text) > 0;
      continue;
    }
    if (!state) continue;
    if (typeof otherCalc === 'function' && otherCalc(text)) { state = null; continue; }
    fresh = followUp(state, text) > 0;
  }
  return state ? toCtx(state, fresh) : null;
}

/* ========== text for the user and for the AI ========== */

function describeInputs(inputs) {
  return Object.entries(inputs || {})
    .filter(([, v]) => v !== undefined && v !== null && Number.isFinite(Number(v)))
    .map(([k, v]) => tools.describeInput(k, v))
    .join(', ');
}

function askText(ctx) {
  const label = LABEL[ctx.intent] || 'calculation';
  const pending = (ctx.ambiguous || []).find(a => a.param === 'prepay_type');
  if (pending) {
    return 'Extra payment ' + tools.formatINR(pending.amount) + ' har mahine dena chahte ho ya ek saath (ek baar)?';
  }
  if (ctx.ambiguous && ctx.ambiguous.length) {
    const a = ctx.ambiguous[0];
    const name = tools.PARAM[a.param] ? tools.PARAM[a.param][0] : a.param;
    return label + ' ke liye "' + name + '" ke liye aapne kai amounts likhe hain (' +
      a.options.map(tools.formatINR).join(', ') + '). Inme se kaunsa sahi hai?';
  }
  const known = describeInputs(ctx.inputs);
  const need = (ctx.missing || []).map(k => (tools.PARAM[k] ? tools.PARAM[k][2] : k));
  return (known ? 'Mujhe ye mil gaya: ' + known + '. ' : '') + label + ' nikalne ke liye ab bas ye batao: ' + need.join(', ') + '.';
}

function hintFor(ctx) {
  const label = LABEL[ctx.intent];
  const known = describeInputs(ctx.inputs);
  const extra = {
    sim_sip: ' Volatility na di ho to tool 15% maanta hai; ye user ko saaf bata do. Ye estimate hai, guarantee nahi.',
    sim_lumpsum: ' Volatility na di ho to tool 15% maanta hai; ye user ko saaf bata do. Ye estimate hai, guarantee nahi.',
    prepay: ' EMI wahi rehti hai, avadhi kam hoti hai; bachat aur kitne mahine pehle khatam hoga, dono batao.',
    tax_calc: ' Tool ke result mein niyam ka saal aur assumptions hain; user ko regime ka fark aur assumptions batao.' +
      (ctx.assumed ? ' Mahine ki income ko 12 se guna karke saal ki income maani gayi; ye user ko bata do.' : ''),
    rate_table: ''
  }[ctx.intent] || '';

  if (ctx.fresh && ctx.complete) {
    return '\n\nConversation se samjha gaya: ' + label + '. Inputs: ' + known + '. ' + ctx.tool +
      ' tool inhi inputs ke saath chalao aur sirf tool ke result batao; ye inputs dobara mat poochho.' + extra;
  }
  if (ctx.fresh) {
    return '\n\n' + label + ' ke liye inputs poore nahi hain. ' + askText(ctx) + ' Sirf yahi poochho.';
  }
  return known ? '\n\nPichhle ' + label + ' calculation ke inputs (agar user usi ke baare mein puchhe): ' + known + '.' : '';
}

/* ========== router override ========== */

function applyToRoute(r, ctx, messages) {
  if (!r || typeof r !== 'object') return r;
  if (['blocked', 'ask_upload', 'confirm_document'].includes(r.action)) return r;

  r.intent = ctx.intent;
  r.kind = 'calc';
  r.mode = 'calculate';
  r.tool = ctx.tool;
  r.tools = [ctx.tool];
  r.inputs = Object.assign({}, ctx.inputs);
  r.missing_fields = ctx.missing.slice();
  r.ambiguous_fields = ctx.ambiguous.map(a => a.param);
  r.steps = [];
  r.pending_questions = [];
  r.concept_intents = [];
  r.finance_related = true;
  r.reasons = (Array.isArray(r.reasons) ? r.reasons : []).concat('cpp_intent');
  r.verification = r.verification && typeof r.verification === 'object' ? r.verification : { required: false };

  if (ctx.intent === 'tax_calc' && !r.verification.required) {
    const last = [...messages].reverse().find(m => m && m.role === 'user');
    r.verification = {
      required: true, workflow: 'verified_lookup', topic: 'tax', trusted_domains: r.verification.trusted_domains || [],
      query: ('income tax slabs rebate standard deduction surcharge ' + (last ? String(last.content).replace(FILE_RE, ' ') : '')).slice(0, 300),
      reason: 'official_facts_needed'
    };
  }

  if (ctx.complete) {
    r.action = r.verification.required ? 'verify_lookup' : 'run_tool';
    r.ready = true;
    r.direct_reply = null;
    r.clarification = { needed: false, reason: null, question: null, options: [] };
  } else {
    const q = askText(ctx);
    const pending = ctx.ambiguous.find(a => a.param === 'prepay_type');
    r.action = 'ask_clarification';
    r.ready = false;
    r.clarification = { needed: true, reason: ctx.ambiguous.length ? 'ambiguous_values' : 'missing_fields', question: q, options: pending ? pending.options.slice() : [] };
    r.direct_reply = q;
  }
  return r;
}

/* ========== install ========== */

function install(deps = {}) {
  try {
    const engine = deps.engine || require('./finance-engine');
    const validator = deps.validator || require('./finance-validator');
    const router = deps.router || require('./intent-router');
    if (engine.__cppInstalled) return { installed: false, reason: 'already installed' };

    const otherCalc = text => {
      try { return engine.detectFinanceIntents(text).some(x => x.calc); } catch (_) { return false; }
    };
    const ctxOf = messages => {
      try { return cppContext(messages, otherCalc); } catch (_) { return null; }
    };

    const orig = {
      buildContext: engine.buildContext,
      promptHint: engine.promptHint,
      askForMissing: engine.askForMissing,
      describeInputs: engine.describeInputs,
      describeResult: engine.describeResult,
      describeCalls: engine.describeCalls,
      verifyCalculation: validator.verifyCalculation,
      validateInputs: validator.validateInputs,
      route: router.route
    };

    const newEngine = {
      buildContext: messages => ctxOf(messages) || orig.buildContext(messages),
      promptHint: messages => {
        const c = ctxOf(messages);
        return c ? hintFor(c) : orig.promptHint(messages);
      },
      askForMissing: ctx => (ctx && ctx._cpp ? askText(ctx) : orig.askForMissing(ctx)),
      describeInputs: inputs => {
        const entries = Object.entries(inputs || {});
        if (!entries.some(([k]) => tools.isOurKey(k) && !['principal', 'annual_rate', 'years', 'monthly_amount', 'annual_return'].includes(k))) {
          return orig.describeInputs(inputs);
        }
        return describeInputs(inputs);
      },
      describeResult: (name, args, result) => (tools.isOurTool(name) && result && !result.error
        ? tools.resultLines(name, args, result).join('\n')
        : orig.describeResult(name, args, result)),
      describeCalls: calls => {
        const list = Array.isArray(calls) ? calls : [];
        const ours = list.filter(c => c && tools.isOurTool(c.name) && c.result && !c.result.error);
        const others = list.filter(c => !(c && tools.isOurTool(c.name)));
        const parts = [];
        if (others.length) parts.push(orig.describeCalls(others));
        for (const c of ours) {
          const head = describeInputs(c.args);
          parts.push((head ? 'Inputs: ' + head + '\n' : '') + tools.resultLines(c.name, c.args, c.result).join('\n'));
        }
        return parts.join('\n\n');
      }
    };

    const newValidator = {
      verifyCalculation: (tool, args, result) => (tools.isOurTool(tool)
        ? tools.verifyCalculation(tool, args, result)
        : orig.verifyCalculation(tool, args, result)),
      validateInputs: (tool, args) => (tools.isOurTool(tool)
        ? { status: 'ok', ok: true, errors: [], warnings: [], values: Object.assign({}, args), confirm: [] }
        : orig.validateInputs(tool, args))
    };

    const newRouter = {
      route: (messages, opts) => {
        const r = orig.route(messages, opts);
        const c = ctxOf(messages);
        return c && c.fresh ? applyToRoute(r, c, Array.isArray(messages) ? messages : []) : r;
      }
    };

    // everything is built; now switch it on
    for (const t of tools.TOOLS) {
      if (!engine.TOOLS.some(x => x.name === t.name)) engine.TOOLS.push(t);
    }
    Object.assign(engine, newEngine);
    Object.assign(validator, newValidator);
    Object.assign(router, newRouter);
    engine.__cppInstalled = true;
    return { installed: true };
  } catch (e) {
    try { console.warn('cpp-integration not installed: ' + (e && e.message)); } catch (_) { /* ignore */ }
    return { installed: false, reason: e && e.message };
  }
}

module.exports = { install, cppContext, parseFacts, detectIntent, normalize, askText, hintFor, applyToRoute, TOOL_OF, __test: { applyText, followUp } };
