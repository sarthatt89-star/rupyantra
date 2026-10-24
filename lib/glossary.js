'use strict';

/*
 * Glossary (lib/glossary.js)
 *
 * Admin panel se daali gayi jaankari (term + matlab). Upstash ke hash "rp:glossary" mein rehti hai.
 *  - Public chat mein tabhi lagti hai jab sawal aam (general) ho, aur usme koi number na ho.
 *    Rate/tax/calculator wale sawal glossary ko nahi chhute (wo verified/calculator se hi jaate hain).
 *  - Matlab plain text hai. Chat aur admin dono mein textContent se dikhta hai, HTML nahi.
 *  - Upstash band ho ya fail ho to chupchap null / empty, site nahi ruki.
 */

const upstash = require('./upstash');

const KEY = 'rp:glossary';
const MAX_ENTRIES = 200;
const MAX_QUESTION_WORDS = 12;

const norm = s => String(s || '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function createGlossary(deps = {}) {
  const redis = deps.redis || upstash;

  async function list() {
    const flat = await redis.cmd('HGETALL', KEY);
    if (!Array.isArray(flat)) return [];
    const out = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      try {
        const e = JSON.parse(flat[i + 1]);
        if (e && typeof e.term === 'string' && typeof e.text === 'string') out.push(e);
      } catch (_) { /* kharab entry chhod do */ }
    }
    return out.sort((a, b) => a.term.localeCompare(b.term));
  }

  function clean(term, text) {
    const t = String(term || '').trim().replace(/\s+/g, ' ');
    const x = String(text || '').trim();
    if (t.length < 2 || t.length > 60) return { error: 'term_length' };
    if (x.length < 10 || x.length > 1500) return { error: 'text_length' };
    if (/[<>]/.test(t) || /[<>]/.test(x)) return { error: 'bad_chars' };
    if (!norm(t)) return { error: 'term_length' };
    return { term: t, text: x };
  }

  async function save(term, text, now = Date.now()) {
    const c = clean(term, text);
    if (c.error) return { ok: false, error: c.error };
    const field = norm(c.term);
    if (!(await redis.cmd('HGET', KEY, field))) {
      const count = (await list()).length;
      if (count >= MAX_ENTRIES) return { ok: false, error: 'too_many' };
    }
    const entry = { term: c.term, text: c.text, updated: new Date(now).toISOString() };
    const r = await redis.cmd('HSET', KEY, field, JSON.stringify(entry));
    if (r === null) return { ok: false, error: 'store_failed' };
    return { ok: true, entry };
  }

  async function remove(term) {
    const field = norm(term);
    if (!field) return { ok: false, error: 'bad_term' };
    const r = await redis.cmd('HDEL', KEY, field);
    if (r === null) return { ok: false, error: 'store_failed' };
    return { ok: true, removed: Number(r) > 0 };
  }

  // Public chat ke liye: sawal mein term hai to uska entry, warna null
  async function lookup(question) {
    try {
      const q = norm(question);
      if (!q || /\d/.test(q) || q.split(' ').length > MAX_QUESTION_WORDS) return null;
      const entries = await list();
      const padded = ' ' + q + ' ';
      const sorted = entries.slice().sort((a, b) => norm(b.term).length - norm(a.term).length);
      for (const e of sorted) {
        const t = norm(e.term);
        if (t && padded.includes(' ' + t + ' ')) return e;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  return { list, save, remove, lookup, clean };
}

const defaultGlossary = createGlossary();

module.exports = {
  createGlossary,
  norm,
  KEY,
  MAX_ENTRIES,
  list: defaultGlossary.list,
  save: defaultGlossary.save,
  remove: defaultGlossary.remove,
  lookup: defaultGlossary.lookup,
};
