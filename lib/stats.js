'use strict';

/*
 * Rupeyantra Stats (lib/stats.js)
 *
 * Roz ki ginti Upstash Redis mein: kitne sawal, kitne fail, kaun sa provider kitna chala,
 * key kitni baar badli, kaun si error kitni baar. Mail se "aaj"/"errors"/"summary" poochhne ke liye yahi data padha jaata hai.
 *
 * Privacy (tests/stats.test.js mein lock):
 *  - Sirf ginti aur naam (jaise "provider.gemini.ok", "intent.emi"). User ka sawal, chat, naam, number kabhi nahi.
 *  - Recent errors mein sirf type/code/provider/time.
 *  - Data 40 din baad apne aap hat jaata hai.
 *  - Upstash na ho ya fail ho to chupchap kuch nahi karta; site ko nahi rokta.
 */

const upstash = require('./upstash');

const DAY_TTL_SEC = 40 * 24 * 3600;
const RECENT_MAX = 50;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

const istDate = t => new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
const safeName = n => String(n).toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 60);
const safeText = v => String(v === undefined || v === null ? '' : v).replace(/[^A-Za-z0-9_ .#,:-]/g, '').slice(0, 60);

function createStats(deps = {}) {
  const redis = deps.redis || upstash;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const dayKey = day => 'rupeyantra:stats:' + day;
  const recentKey = 'rupeyantra:errors:recent';

  const isConfigured = () => redis.isConfigured();

  // counters = { requests: 1, 'provider.gemini.ok': 1 }; err (optional) = { type, code, provider }
  async function record(counters, err) {
    try {
      if (!redis.isConfigured()) return false;
      const key = dayKey(istDate(now()));
      const cmds = Object.entries(counters || {})
        .filter(([, n]) => Number.isFinite(n) && n > 0)
        .slice(0, 30)
        .map(([name, n]) => ['HINCRBY', key, safeName(name), String(Math.round(n))]);
      if (!cmds.length && !err) return false;
      cmds.push(['EXPIRE', key, String(DAY_TTL_SEC)]);
      if (err) {
        const entry = JSON.stringify({
          t: new Date(now()).toISOString(),
          type: safeText(err.type),
          code: safeText(err.code),
          provider: safeText(err.provider)
        });
        cmds.push(['LPUSH', recentKey, entry], ['LTRIM', recentKey, '0', String(RECENT_MAX - 1)], ['EXPIRE', recentKey, String(DAY_TTL_SEC)]);
      }
      return Boolean(await redis.pipeline(cmds));
    } catch (_) {
      return false;
    }
  }

  // day = 'YYYY-MM-DD' (IST); na do to aaj. Lautata hai { counters, available }
  async function readDay(day) {
    try {
      if (!redis.isConfigured()) return { counters: {}, available: false };
      const flat = await redis.cmd('HGETALL', dayKey(day || istDate(now())));
      if (!Array.isArray(flat)) return { counters: {}, available: false };
      const counters = {};
      for (let i = 0; i + 1 < flat.length; i += 2) counters[flat[i]] = Number(flat[i + 1]) || 0;
      return { counters, available: true };
    } catch (_) {
      return { counters: {}, available: false };
    }
  }

  async function readRecentErrors(limit = 10) {
    try {
      if (!redis.isConfigured()) return [];
      const list = await redis.cmd('LRANGE', recentKey, '0', String(Math.max(0, Math.min(RECENT_MAX, limit) - 1)));
      if (!Array.isArray(list)) return [];
      return list.map(x => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  const today = () => istDate(now());
  const yesterday = () => istDate(now() - 24 * 3600 * 1000);

  return { record, readDay, readRecentErrors, isConfigured, today, yesterday };
}

const defaultStats = createStats();

module.exports = {
  createStats,
  record: defaultStats.record,
  readDay: defaultStats.readDay,
  readRecentErrors: defaultStats.readRecentErrors,
  isConfigured: defaultStats.isConfigured,
  today: defaultStats.today,
  yesterday: defaultStats.yesterday,
  istDate
};
