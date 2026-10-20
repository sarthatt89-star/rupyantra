'use strict';

/*
 * Admin chat API (api/admin/chat.js)
 *   POST /api/admin/chat   body { message, history? }  -> login ke baad, report + knowledge par based jawab
 * Sirf admin. Koi badlaav nahi karta. Kuch save nahi hota.
 */

const { createAdminAuth, parseCookie, COOKIE } = require('../../lib/admin-auth');
const { createMailer } = require('../../lib/mailer');
const { createStatus } = require('../../lib/admin-status');
const { createAsk, MAX_QUESTION } = require('../../lib/admin-chat');
const upstash = require('../../lib/upstash');
const eh = require('../../lib/error-handler');

const HOUR_MS = 3600 * 1000;
const HOURLY_CAP = 60;
let hits = [];

function underCap(t = Date.now()) {
  hits = hits.filter(x => t - x < HOUR_MS);
  if (hits.length >= HOURLY_CAP) return false;
  hits.push(t);
  return true;
}

function sameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  const host = (req.headers && req.headers.host) || '';
  return origin === 'https://' + host || origin === 'http://' + host;
}

function parseBody(body) {
  if (typeof body === 'string') {
    try { return JSON.parse(body) || {}; } catch (_) { return {}; }
  }
  return body && typeof body === 'object' ? body : {};
}

function createHandler(deps = {}) {
  const auth = deps.auth || createAdminAuth({ env: process.env, redis: upstash, mailer: createMailer() });
  const status = deps.status || createStatus({});
  const ask = deps.ask || createAsk({ env: process.env });

  return async function adminChatHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }
    try {
      const token = parseCookie(req.headers && req.headers.cookie, COOKIE);
      const session = await auth.checkSession(token);
      if (!session) return res.status(401).json({ ok: false, error: 'not_logged_in' });
      if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'bad_origin' });

      const body = parseBody(req.body);
      const message = String(body.message || '').trim();
      if (!message || message.length > MAX_QUESTION) {
        return res.status(400).json({ ok: false, error: 'bad_message', message: '1 se ' + MAX_QUESTION + ' akshar ka sawal likhein.' });
      }
      if (!underCap()) {
        return res.status(429).json({ ok: false, error: 'rate_limited', message: 'Ghante ki limit poori ho gayi.' });
      }

      const report = await status.build();
      try {
        const answer = await ask(message, report, body.history);
        return res.status(200).json({ ok: true, answer });
      } catch (_) {
        return res.status(503).json({ ok: false, error: 'ai_unavailable', message: 'AI abhi available nahi. Thodi der baad try karein.' });
      }
    } catch (e) {
      eh.logError(e, { where: 'admin-chat' });
      return res.status(500).json({ ok: false, error: 'server_error', message: 'Kuch gadbad ho gayi.' });
    }
  };
}

const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
