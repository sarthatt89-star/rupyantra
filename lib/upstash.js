'use strict';

/*
 * Rupeyantra Upstash client (lib/upstash.js)
 *
 * Upstash Redis ka chhota REST client (koi dependency nahi, sirf fetch).
 * Env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (Vercel mein; quotes ho to bhi chalta hai).
 *
 * Niyam:
 *  - Kabhi throw nahi karta; fail/slow ho to null lautata hai (site ko nahi rokta).
 *  - Har call par timeout (default 1.2 second).
 *  - URL/token kabhi log ya error mein nahi jaate.
 */

const DEFAULT_TIMEOUT_MS = 1200;
const clean = v => String(v === undefined || v === null ? '' : v).trim().replace(/^["']+|["']+$/g, '').trim();

function createRedis(deps = {}) {
  const env = deps.env || process.env;

  const config = () => {
    const url = clean(env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, '');
    const token = clean(env.UPSTASH_REDIS_REST_TOKEN);
    return /^https:\/\//i.test(url) && token ? { url, token } : null;
  };

  const isConfigured = () => Boolean(config());

  // commands = [['HINCRBY', 'key', 'field', '1'], ['EXPIRE', 'key', '100']] => [result, ...] ya null
  async function pipeline(commands, opts = {}) {
    const cfg = config();
    if (!cfg || !Array.isArray(commands) || !commands.length) return null;
    const doFetch = deps.fetch || global.fetch;
    if (typeof doFetch !== 'function') return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS);
    try {
      const r = await doFetch(cfg.url + '/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands.map(c => c.map(String))),
        signal: controller.signal
      });
      if (!r || !r.ok) return null;
      const data = await r.json();
      if (!Array.isArray(data)) return null;
      return data.map(x => (x && x.error ? null : x && x.result));
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function cmd(...args) {
    const r = await pipeline([args]);
    return r ? r[0] : null;
  }

  return { isConfigured, pipeline, cmd };
}

const defaultRedis = createRedis();

module.exports = {
  createRedis,
  isConfigured: defaultRedis.isConfigured,
  pipeline: defaultRedis.pipeline,
  cmd: defaultRedis.cmd
};
