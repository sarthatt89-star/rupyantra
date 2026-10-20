'use strict';

/*
 * Rupeyantra Upstash client (lib/upstash.js)
 * Upstash Redis ka chhota REST client (sirf fetch). Env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN.
 *  - Kabhi throw nahi karta; fail/slow ho to null.
 *  - Default timeout 1.2s (chat/stats ke liye). Admin login jaisi zaroori jagah cmdWith({timeoutMs}) se lamba timeout.
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

  async function cmdWith(opts, ...args) {
    const r = await pipeline([args], opts);
    return r ? r[0] : null;
  }

  const cmd = (...args) => cmdWith({}, ...args);

  return { isConfigured, pipeline, cmd, cmdWith };
}

const defaultRedis = createRedis();

module.exports = {
  createRedis,
  isConfigured: defaultRedis.isConfigured,
  pipeline: defaultRedis.pipeline,
  cmd: defaultRedis.cmd,
  cmdWith: defaultRedis.cmdWith
};
