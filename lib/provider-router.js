'use strict';

/*
 * Rupeyantra Provider Router (lib/provider-router.js)
 *
 * Kaam: sawal ke type ke hisaab se tay karna ki kaun sa AI provider pehle try ho.
 *   media = photo/PDF          facts = rate/tax/scheme (verified jankari ke saath)
 *   calc  = calculator wale    chat  = concept / aam baatcheet
 *   long  = lamba text ya file ka text
 * Har type ka apna order (PROFILES). Jiski saari keys abhi cooldown mein hon, wo list mein peeche chala jaata hai.
 * Order badalna ho to Vercel env AI_ROUTING:  calc=groq,gemini; chat=cerebras,groq
 *   (jo naam diye wo pehle, baaki apne order mein). Ye sirf order badalta hai; jiski key nahi, wo waise bhi nahi chalta.
 * Ye file koi network call ya key nahi chhoti.
 */

const providers = require('./providers');

const PROFILES = Object.freeze({
  media: ['gemini', 'openai', 'openrouter'],
  facts: ['gemini', 'groq', 'sambanova', 'openai', 'cerebras', 'mistral', 'deepseek', 'together', 'xai', 'custom', 'openrouter'],
  calc: ['gemini', 'groq', 'openai', 'sambanova', 'cerebras', 'mistral', 'deepseek', 'together', 'xai', 'custom', 'openrouter'],
  chat: ['groq', 'cerebras', 'sambanova', 'gemini', 'mistral', 'deepseek', 'together', 'xai', 'custom', 'openrouter', 'openai'],
  long: ['gemini', 'openai', 'sambanova', 'groq', 'mistral', 'deepseek', 'together', 'cerebras', 'xai', 'custom', 'openrouter']
});

const CATEGORIES = Object.keys(PROFILES);
const LONG_CHARS = 2500;

function categoryOf({ route, hasMedia, text } = {}) {
  if (hasMedia) return 'media';
  const r = route || {};
  if (r.action === 'verify_lookup' || (r.verification && r.verification.required)) return 'facts';
  if (r.action === 'run_tool' || r.action === 'run_multi' || r.mode === 'calculate' || r.mode === 'multi') return 'calc';
  const t = String(text || '');
  if (r.mode === 'document' || /\[FILE: /.test(t) || t.length > LONG_CHARS) return 'long';
  return 'chat';
}

// "calc=groq,gemini; chat=cerebras" => { calc: ['groq','gemini'], chat: ['cerebras'] }
function parseOverride(env = process.env) {
  const out = {};
  for (const part of String(env.AI_ROUTING || '').split(';')) {
    const m = part.trim().match(/^([a-z]+)\s*=\s*(.+)$/i);
    if (!m || !PROFILES[m[1].toLowerCase()]) continue;
    out[m[1].toLowerCase()] = m[2].split(/[\s,>]+/).map(x => x.trim().toLowerCase()).filter(n => providers.byName(n));
  }
  return out;
}

function orderFor(category, env = process.env) {
  const over = parseOverride(env)[category] || [];
  const all = [...over, ...(PROFILES[category] || []), ...providers.PRIORITY.map(d => d.name)];
  return [...new Set(all)].filter(n => providers.byName(n));
}

// list = [{ name, ... }] (jo provider chal sakte hain). Lautata hai { category, list } naye order mein.
function order(list, ctx = {}) {
  const env = ctx.env || process.env;
  const category = categoryOf(ctx);
  const rank = orderFor(category, env);
  const healthy = p => {
    try {
      const s = ctx.pools && ctx.pools[p.name] && ctx.pools[p.name].summary();
      return !s || s.total === 0 || s.available > 0;
    } catch (_) { return true; }
  };
  const key = p => [healthy(p) ? 0 : 1, rank.indexOf(p.name) === -1 ? 99 : rank.indexOf(p.name)];
  const sorted = (Array.isArray(list) ? list : []).map((p, i) => ({ p, i, k: key(p) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i)
    .map(x => x.p);
  return { category, list: sorted };
}

// Admin panel ke liye: har type ka order (sirf naam)
function describe(env = process.env) {
  const out = { override: Boolean(String(env.AI_ROUTING || '').trim()), profiles: {} };
  for (const c of CATEGORIES) out.profiles[c] = orderFor(c, env);
  return out;
}

module.exports = { PROFILES, CATEGORIES, categoryOf, parseOverride, orderFor, order, describe };
