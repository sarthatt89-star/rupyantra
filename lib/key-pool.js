'use strict';

/*
 * Rupeyantra Key Pool (lib/key-pool.js)
 *
 * Kaam: ek provider ki kai API keys ko sambhalna. Jo key limit/quota/auth error de, use thodi der ke liye
 * "cooldown" mein daal kar agli key se wahi request dobara chalana.
 *
 * Vercel env mein keys aise do (kisi bhi tareeke se, ya mila kar):
 *   GEMINI_API_KEY      = pehli key
 *   GEMINI_API_KEY_1 .. GEMINI_API_KEY_10 = aur keys
 *   GEMINI_API_KEYS     = key1,key2,key3   (comma / space / new line se alag)
 * Yahi tareeka GROQ_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY par bhi chalta hai.
 *
 * Rules:
 *  - Keys list ke order mein try hoti hain (pehli key primary, baaki backup).
 *  - Sirf rate-limit/quota (429) aur auth/billing (401/403/402) errors par key badalti hai.
 *    Timeout, 5xx ya galat request par key nahi badalti (wo key ka kasoor nahi).
 *  - Key kabhi log ya response mein nahi jaati; sirf label ("GEMINI_API_KEY#2") dikhta hai.
 *  - Cooldown per warm Vercel instance memory mein rehta hai (restart par reset).
 *  - Keys har call par env se padhi jaati hain, isliye env badalne par redeploy ke baad turant lagu.
 *  - withKeys(..., { onRotate }) key badalte waqt hook bulata hai (Gmail alert ke liye).
 */

const crypto = require('node:crypto');
const eh = require('./error-handler');

const MAX_NUMBERED = 10;

const COOLDOWN_MS = Object.freeze({
  rateDefault: 60 * 1000,      // retry-after na mile to
  rateMin: 5 * 1000,
  rateMax: 10 * 60 * 1000,
  rateSingleKeyMax: 15 * 1000, // sirf ek key ho to jaldi dobara try (provider poora band na ho)
  quota: 30 * 60 * 1000,       // daily quota jaisi sakht limit (kai keys hon to)
  quotaSingleKey: 5 * 60 * 1000,
  auth: 6 * 60 * 60 * 1000     // galat/expired/billing key
});

/* ---------- env se keys padhna ---------- */

function readKeys(base, env = process.env) {
  const out = [];
  const add = v => {
    const k = String(v === undefined || v === null ? '' : v).trim();
    if (k && !out.includes(k)) out.push(k);
  };

  add(env[base]);
  for (let i = 1; i <= MAX_NUMBERED; i++) add(env[base + '_' + i]);
  String(env[base + 'S'] || '').split(/[\s,;]+/).forEach(add);
  return out;
}

const fingerprint = key => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* ---------- pool ---------- */

function createKeyPool(base, opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const cooling = new Map(); // fingerprint -> { until, reason }

  const list = () => readKeys(base, env).map((key, index) => ({ key, index, id: fingerprint(key) }));

  function isCooling(id, t) {
    const s = cooling.get(id);
    if (!s) return false;
    if (s.until <= t) {
      cooling.delete(id);
      return false;
    }
    return true;
  }

  return {
    name: base,

    size: () => list().length,

    // Agli kaam karne wali key (exclude = is request mein pehle try ho chuki keys)
    acquire(exclude = new Set()) {
      const t = now();
      const usable = list().filter(k => !exclude.has(k.id) && !isCooling(k.id, t));
      if (!usable.length) return null;
      const pick = usable[0];
      return {
        key: pick.key,
        id: pick.id,
        label: base + '#' + (pick.index + 1),
        othersAvailable: usable.length - 1
      };
    },

    success(id) {
      cooling.delete(id);
    },

    // Kya is error par doosri key try karni chahiye?
    shouldRotate: info => Boolean(info) && (info.type === eh.ERROR_TYPES.RATE_LIMIT || info.type === eh.ERROR_TYPES.AUTH),

    penalize(id, info) {
      const total = list().length;
      let ms;
      let reason;

      if (info.type === eh.ERROR_TYPES.AUTH) {
        ms = COOLDOWN_MS.auth;
        reason = 'auth';
      } else if (info.code === 'QUOTA_EXHAUSTED' || /per day|daily/i.test(info.message || '')) {
        ms = total > 1 ? COOLDOWN_MS.quota : COOLDOWN_MS.quotaSingleKey;
        reason = 'quota';
      } else {
        const wait = typeof info.retryAfterMs === 'number' ? info.retryAfterMs : COOLDOWN_MS.rateDefault;
        const cap = total > 1 ? COOLDOWN_MS.rateMax : COOLDOWN_MS.rateSingleKeyMax;
        ms = clamp(wait, COOLDOWN_MS.rateMin, cap);
        reason = 'rate';
      }

      cooling.set(id, { until: now() + ms, reason });
      if (cooling.size > 50) {
        const t = now();
        for (const [k, v] of cooling) if (v.until <= t) cooling.delete(k);
      }
    },

    nextAvailableInMs() {
      const t = now();
      let min = null;
      for (const k of list()) {
        const s = cooling.get(k.id);
        if (!s || s.until <= t) return 0;
        const left = s.until - t;
        if (min === null || left < min) min = left;
      }
      return min === null ? COOLDOWN_MS.rateDefault : min;
    },

    // Sirf ginti (debug/health ke liye); keys kabhi nahi
    summary() {
      const t = now();
      const all = list();
      const coolingNow = all.filter(k => isCooling(k.id, t)).length;
      return { total: all.length, available: all.length - coolingNow, cooling: coolingNow };
    }
  };
}

/* ---------- keys ke saath kaam chalana ---------- */

// fn({ key, fast, label }) ko pehli chalti key se chalata hai.
// Rate-limit/auth error par key ko cooldown mein daal kar agli key se dobara chalata hai.
// fast = true matlab aur keys bachi hain, isliye 429 par wahi key dobara try karne ka fayda nahi.
// opts.onRotate(type, label): key badalte waqt bulaya jaata hai (type: 'auth' ya 'rate_limit').
// Hook fail ho to bhi request chalti rehti hai. Hook await hota hai, taaki serverless mein
// response ke baad email beech mein na kat jaye.
async function withKeys(pool, name, fn, opts = {}) {
  const tried = new Set();
  let lastErr = null;

  for (;;) {
    const slot = pool.acquire(tried);
    if (!slot) break;
    tried.add(slot.id);

    try {
      const out = await fn({ key: slot.key, fast: slot.othersAvailable > 0, label: slot.label });
      pool.success(slot.id);
      return out;
    } catch (e) {
      const info = eh.classifyError(e, { provider: name, source: 'provider' });
      if (!pool.shouldRotate(info)) throw e;

      pool.penalize(slot.id, info);
      eh.logError(e, { where: 'key_rotate', provider: slot.label, source: 'provider' });

      if (opts && typeof opts.onRotate === 'function') {
        try { await opts.onRotate(info.type, slot.label); } catch (_) { /* hook fail ho to bhi chalo */ }
      }
      lastErr = e;
    }
  }

  if (lastErr) throw lastErr;
  if (!pool.size()) throw new Error(name + ' API key missing');

  throw new eh.AppError({
    type: eh.ERROR_TYPES.RATE_LIMIT,
    scope: 'provider',
    code: 'ALL_KEYS_COOLING',
    retryAfterMs: pool.nextAvailableInMs(),
    message: name + ' ki saari keys abhi cooldown mein hain'
  });
}

module.exports = { createKeyPool, withKeys, readKeys, COOLDOWN_MS };
