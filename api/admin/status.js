'use strict';

/*
 * Admin status API (api/admin/status.js)
 *   GET /api/admin/status  -> sirf login ke baad; read-only report
 * Status module login jaanch ke baad load hota hai; kharab ho to logged-in admin ko saaf error milta hai.
 */

const { createAdminAuth, parseCookie, COOKIE } = require('../../lib/admin-auth');
const { createMailer } = require('../../lib/mailer');
const upstash = require('../../lib/upstash');
const eh = require('../../lib/error-handler');

function createHandler(deps = {}) {
  let auth = deps.auth;
  let status = deps.status;

  return async function statusHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }
    let stage = 'auth';
    try {
      if (!auth) auth = createAdminAuth({ env: process.env, redis: upstash, mailer: createMailer() });
      const token = parseCookie(req.headers && req.headers.cookie, COOKIE);
      const session = await auth.checkSession(token);
      if (!session) return res.status(401).json({ ok: false, error: 'not_logged_in' });

      stage = 'load';
      if (!status) status = require('../../lib/admin-status').createStatus({});
      stage = 'status';
      const report = await status.build();
      return res.status(200).json(report);
    } catch (e) {
      eh.logError(e, { where: 'admin-status-' + stage });
      const detail = eh.sanitize(e && e.message ? String(e.message).split('\n')[0] : '', { maxLen: 160 });
      return res.status(500).json({
        ok: false,
        error: stage === 'load' ? 'load_failed' : 'server_error',
        message: stage === 'load' ? 'Server ka code load nahi hua.' : 'Kuch gadbad ho gayi (' + stage + ').',
        detail: stage === 'auth' ? undefined : detail
      });
    }
  };
}

const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
