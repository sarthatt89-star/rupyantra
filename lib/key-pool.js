'use strict';

/*
 * Rupeyantra Key Pool (lib/key-pool.js)
 * Ek provider ki kai API keys sambhalna. Limit/quota/auth error par key cooldown mein, agli key se wahi request.
 *
 * Keys kahan se: BASE, BASE_1..BASE_10, BASES=k1,k2 (env), aur opts.extraKeys() (lib/providers.js: AI_KEYS ya
 * koi bhi KEY wala env, prefix se pehchaan). Jitni marzi keys, sab ek pool mein judti hain.
 * Rules: sirf 429 aur 401/402/403 par key badalti hai; timeout/5xx par nahi. Key kabhi log/response mein nahi.
 */

const crypto = require('node:crypto');
const eh = require('./error-handler');

const MAX_NUMBERED = 10;

const COOLDOWN_MS = Object.freeze({
  rateDefault: 60 * 1000,
  rateMin: 5 * 1000,
  rateMax: 10 * 60 * 1000,
  rateSingleKeyMax: 15 * 1000,
  quota: 30 * 60 * 1000,
  quotaSingleKey: 5 * 60 * 1000,
  auth: 6 * 60 * 60 * 1000
});

function readKeys(base, env = process.env) {
  const out = [];
  const add = v => {
    const k = String(v === undefined || v === null ? '' : v).trim().replace(/^["']+|["']+$/g, '').trim();
    if (k && !out.includes(k)) out.push(k);
  };

  add(env[base]);
  for (let i = 1; i <= MAX_NUMBERED; i++) add(env[base + '_' + i]);
  String(env[base + 'S'] || '').split(/[\s,;]+/).forEach(add);
  return out;
}

const fingerprint = key => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function createKeyPool(base, opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  // extraKeys na diya ho to lib/providers.js se (AI_KEYS ya koi bhi KEY wala env) is provider ki extra keys li jaati hain
  const extra = typeof opts.extraKeys === 'function' ? opts.extraKeys : () => {
    try {
      const P = require('./providers');
      const d = P.DEFS.find(x => x.base === base);
      return d ? P.extraKeys(d.name, env) : [];
    } catch (_) { return []; }
  };
  const cooling = new Map();

  const list = () => {
    const all = readKeys(base, env);
    try { for (const k of extra()) if (k && !all.includes(k)) all.push(k); } catch (_) { /* extra source fail ho to env keys chalti rahen */ }
    return all.map((key, index) => ({ key, index, id: fingerprint(key) }));
  };

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

    summary() {
      const t = now();
      const all = list();
      const coolingNow = all.filter(k => isCooling(k.id, t)).length;
      return { total: all.length, available: all.length - coolingNow, cooling: coolingNow };
    }
  };
}

async function withKeys(pool, name, fn, hooks = {}) {
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
      lastErr = e;
      if (typeof hooks.onRotate === 'function') {
        try { await hooks.onRotate(info.type, slot.label, info); } catch (_) { /* hook ki galti request nahi rokti */ }
      }
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
