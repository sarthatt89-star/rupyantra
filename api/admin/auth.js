'use strict';

/*
 * Admin login API (api/admin/auth.js)
 *
 *   POST /api/admin/auth?action=request   -> admin email par OTP
 *   POST /api/admin/auth?action=verify    -> body { code } ; sahi ho to session cookie
 *   POST /api/admin/auth?action=logout    -> session band
 *   GET  /api/admin/auth?action=session   -> { ok, email } ya 401
 *
 * Jawab mein kabhi internal detail (keys, config, store ki halat) nahi jaati.
 */

const { createAdminAuth, parseCookie, serializeCookie, clearCookie, COOKIE } = require('../../lib/admin-auth');
const { createMailer } = require('../../lib/mailer');
const upstash = require('../../lib/upstash');
const eh = require('../../lib/error-handler');

const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX = 20;
const ipHits = new Map();

function ipLimited(ip, t = Date.now()) {
  const arr = (ipHits.get(ip) || []).filter(x => t - x < IP_WINDOW_MS);
  if (arr.length >= IP_MAX) {
    ipHits.set(ip, arr);
    return true;
  }
  arr.push(t);
  ipHits.set(ip, arr);
  if (ipHits.size > 2000) ipHits.clear();
  return false;
}

function clientIp(req) {
  const f = req.headers && req.headers['x-forwarded-for'];
  return (typeof f === 'string' ? f.split(',')[0].trim() : '') || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Browser POST hamesha Origin bhejta hai. Alag origin ho to rok do (CSRF ka dusra bachav).
function sameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  const host = (req.headers && req.headers.host) || '';
  return origin === 'https://' + host || origin === 'http://' + host;
}

function actionOf(req) {
  if (req.query && typeof req.query === 'object') return String(req.query.action || '');
  try {
    return new URL(req.url || '', 'http://x').searchParams.get('action') || '';
  } catch (_) {
    return '';
  }
}

function parseBody(body) {
  if (typeof body === 'string') {
    try { return JSON.parse(body) || {}; } catch (_) { return {}; }
  }
  return body && typeof body === 'object' ? body : {};
}

// Auth result ko user ke liye safe jawab mein badalna (status/token andar hi rehte hain)
function publicResult(r) {
  if (r.ok) return { ok: true, message: r.message };
  const out = { ok: false, error: r.error || 'error', message: r.message || 'Kuch gadbad ho gayi.' };
  if (r.left !== undefined) out.left = r.left;
  return out;
}

function createHandler(deps = {}) {
  const auth = deps.auth || createAdminAuth({
    env: process.env,
    redis: upstash,
    mailer: createMailer(),
  });

  return async function adminAuthHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const send = (status, body, headers) => {
      if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      return res.status(status).json(body);
    };

    try {
      const action = actionOf(req);
      const token = parseCookie(req.headers && req.headers.cookie, COOKIE);

      if (action === 'session') {
        if (req.method !== 'GET') return send(405, { ok: false, error: 'method_not_allowed' });
        const s = await auth.checkSession(token);
        return s ? send(200, { ok: true, email: s.email }) : send(401, { ok: false, error: 'not_logged_in' });
      }

      if (!['request', 'verify', 'logout'].includes(action)) {
        return send(404, { ok: false, error: 'not_found' });
      }
      if (req.method !== 'POST') {
        return send(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
      }
      if (!sameOrigin(req)) {
        return send(403, { ok: false, error: 'bad_origin', message: 'Ye request allowed nahi hai.' });
      }
      if (ipLimited(clientIp(req))) {
        return send(429, { ok: false, error: 'rate_limited', message: 'Thodi der baad try karein.' });
      }

      const body = parseBody(req.body);

      if (action === 'request') {
        const r = await auth.requestOtp();
        return send(r.status, publicResult(r));
      }

      if (action === 'verify') {
        const r = await auth.verifyOtp(body.code);
        if (r.ok) {
          return send(200, publicResult(r), { 'Set-Cookie': serializeCookie(r.token, r.maxAge) });
        }
        return send(r.status, publicResult(r));
      }

      // logout
      await auth.destroySession(token);
      return send(200, { ok: true, message: 'Logout ho gaya.' }, { 'Set-Cookie': clearCookie() });
    } catch (e) {
      eh.logError(e, { where: 'admin-auth' });
      return send(500, { ok: false, error: 'server_error', message: 'Kuch gadbad ho gayi.' });
    }
  };
}

const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
