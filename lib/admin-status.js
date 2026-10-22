'use strict';

/*
 * Admin status report (lib/admin-status.js)
 *
 * Sirf padhta hai. Kuch badalta nahi, koi AI provider call nahi hota, koi key nahi dikhti.
 *  - Site: SITE_URL ke / , /ai , /api/chat (GET, bina AI tokens ke) ka status aur time
 *  - Calculator: EMI aur SIP ke fixed test inputs, engine ka result verifier se cross-check
 *  - Keys: har provider mein kitni keys, kitni chalu, kitni cooldown mein (keys kabhi nahi)
 *  - Env: kaun sa Vercel env set hai ya nahi (sirf haan/na, value kabhi nahi)
 *  - Gmail alert aur Upstash store chalu hain ya nahi
 *  - Aaj ki ginti aur haal ki errors (sirf type, code, provider, time)
 */

const engine = require('./finance-engine');
const validator = require('./finance-validator');
const providers = require('./providers');
const providerRouter = require('./provider-router');
const alerts = require('./alert');
const defaultStats = require('./stats');

const PROVIDERS = providers.NAMES;
const PAGE_TIMEOUT_MS = 5000;
// Provider keys ke naam jaan-boojh kar nahi: unka haal "keys" section mein hai
const ENV_FLAGS = ['ADMIN_SESSION_SECRET', 'ADMIN_EMAIL', 'SITE_URL', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'ALERT_TO',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'MAIL_ASK_SECRET', 'MAIL_ASK_PIN', 'MAIL_ASK_ALLOWED', 'ADMIN_TOKEN', 'DEBUG_ERRORS'];

const safeText = (v, max = 60) =>
  String(v === undefined || v === null ? '' : v).replace(/[^A-Za-z0-9_ .#,:/-]/g, '').slice(0, max);

function createStatus(deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || global.fetch;
  const store = deps.stats || defaultStats;
  const now = deps.now || Date.now;
  const alertsConfigured = deps.alertsConfigured || (() => alerts.isConfigured());

  function siteOrigin() {
    const raw = String(env.SITE_URL || '').trim().replace(/\/+$/, '');
    try {
      const u = new URL(raw);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
    } catch (_) {
      return null;
    }
  }

  // Sirf GET, redirect follow nahi, timeout ke saath
  async function probe(url) {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
    try {
      const r = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': 'Rupeyantra-Admin-Status/1.0' },
      });
      const status = Number(r && r.status) || 0;
      return { ok: status >= 200 && status < 300, status, ms: Date.now() - started };
    } catch (e) {
      return {
        ok: false,
        status: null,
        ms: Date.now() - started,
        error: e && e.name === 'AbortError' ? 'timeout' : 'network_error',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // Calculator ke fixed test inputs, engine ka result independent verifier se check
  function calculatorChecks() {
    const check = (tool, args) => {
      const result = engine.runTool(tool, args);
      if (result && result.error) return { ok: false, note: 'engine_error' };
      const verdict = validator.verifyCalculation(tool, args, result);
      return { ok: Boolean(verdict.ok), note: verdict.ok ? 'verified' : 'mismatch' };
    };
    return {
      emi: check('calc_emi', { principal: 5000000, annual_rate: 8.5, years: 20 }),
      sip: check('calc_sip', { monthly_amount: 5000, annual_return: 12, years: 10 }),
    };
  }

  // Har provider ki keys (apne env + AI_KEYS + koi bhi KEY wala env), sirf ginti
  function keySummary() {
    const pools = providers.makePools(env);
    const out = {};
    for (const p of PROVIDERS) out[p] = pools[p].summary();
    return out;
  }

  function envFlags() {
    const out = {};
    for (const k of ENV_FLAGS) out[k] = Boolean(String(env[k] || '').trim());
    return out;
  }

  async function build() {
    const checkedAt = new Date(now()).toISOString();
    const origin = siteOrigin();
    const site = origin
      ? {
          home: await probe(origin + '/'),
          ai: await probe(origin + '/ai'),
          chatApi: await probe(origin + '/api/chat'),
        }
      : { config: { ok: false, note: 'SITE_URL set nahi hai' } };

    const calculator = calculatorChecks();
    const storeOk = Boolean(store.isConfigured && store.isConfigured());

    let today = { counters: {}, available: false };
    let recent = [];
    if (storeOk) {
      today = await store.readDay(store.today());
      recent = await store.readRecentErrors(10);
    }
    const c = today.counters || {};

    const siteOk = origin
      ? Boolean(site.home.ok && site.ai.ok && site.chatApi.ok)
      : false;
    const ok = siteOk && calculator.emi.ok && calculator.sip.ok;

    return {
      ok,
      checkedAt,
      site,
      calculator,
      keys: keySummary(),
      routing: providerRouter.describe(env),
      env: envFlags(),
      alerts: { configured: Boolean(alertsConfigured()) },
      store: { configured: storeOk },
      today: {
        available: Boolean(today.available),
        requests: Number(c.requests) || 0,
        ok: Number(c.ok) || 0,
        fail: Number(c.fail) || 0,
        picks: Object.fromEntries(providerRouter.CATEGORIES.map(k => [k, Number(c['pick.' + k]) || 0])),
      },
      recentErrors: recent.slice(0, 10).map(e => ({
        t: safeText(e.t, 40),
        type: safeText(e.type),
        code: safeText(e.code),
        provider: safeText(e.provider),
      })),
    };
  }

  return { build };
}

module.exports = { createStatus };
