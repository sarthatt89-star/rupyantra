'use strict';

/*
 * Admin status API (api/admin/status.js)
 *   GET /api/admin/status  -> sirf login ke baad; read-only report
 */

const { createAdminAuth, parseCookie, COOKIE } = require('../../lib/admin-auth');
const { createMailer } = require('../../lib/mailer');
const { createStatus } = require('../../lib/admin-status');
const upstash = require('../../lib/upstash');
const eh = require('../../lib/error-handler');

function createHandler(deps = {}) {
  const auth = deps.auth || createAdminAuth({ env: process.env, redis: upstash, mailer: createMailer() });
  const status = deps.status || createStatus({});

  return async function statusHandler(req, res) {
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

      const report = await status.build();
      return res.status(200).json(report);
    } catch (e) {
      eh.logError(e, { where: 'admin-status' });
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  };
}

const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
