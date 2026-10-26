'use strict';

/*
 * Sawal report API (api/admin/report.js) -- sirf login ke baad, read-only
 *   GET /api/admin/report?day=2026-10-19   (day na ho to aaj)
 */

const { createAdminAuth, parseCookie, COOKIE } = require('../../lib/admin-auth');
const { createMailer } = require('../../lib/mailer');
const { createQuestionReport } = require('../../lib/question-report');
const upstash = require('../../lib/upstash');
const eh = require('../../lib/error-handler');

function queryParam(req, name) {
  try {
    if (req.query && typeof req.query === 'object') return req.query[name];
    return new URL(req.url || '', 'http://x').searchParams.get(name) || undefined;
  } catch (_) {
    return undefined;
  }
}

function createHandler(deps = {}) {
  const auth = deps.auth || createAdminAuth({ env: process.env, redis: upstash, mailer: createMailer() });
  const report = deps.report || createQuestionReport({});

  return async function reportHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }
    try {
      const token = parseCookie(req.headers && req.headers.cookie, COOKIE);
      const session = await auth.checkSession(token);
      if (!session) return res.status(401).json({ ok: false, error: 'not_logged_in' });
      const data = await report.build(queryParam(req, 'day'));
      return res.status(200).json({ ok: true, ...data });
    } catch (e) {
      eh.logError(e, { where: 'admin-report' });
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  };
}

const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
