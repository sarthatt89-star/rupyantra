'use strict';

/*
 * Glossary API (api/admin/glossary.js)  -- sirf login ke baad
 *   GET    /api/admin/glossary                 -> sab entries
 *   POST   /api/admin/glossary   body {term,text} -> save (naya ya update)
 *   DELETE /api/admin/glossary?term=SIP        -> hatao
 */

const { createAdminAuth, parseCookie, COOKIE } = require('../../lib/admin-auth');
const { createMailer } = require('../../lib/mailer');
const glossaryLib = require('../../lib/glossary');
const upstash = require('../../lib/upstash');
const eh = require('../../lib/error-handler');

function sameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  const host = (req.headers && req.headers.host) || '';
  return origin === 'https://' + host || origin === 'http://' + host;
}

function queryParam(req, name) {
  try {
    if (req.query && typeof req.query === 'object') return req.query[name];
    return new URL(req.url || '', 'http://x').searchParams.get(name) || undefined;
  } catch (_) {
    return undefined;
  }
}

function parseBody(body) {
  if (typeof body === 'string') {
    try { return JSON.parse(body) || {}; } catch (_) { return {}; }
  }
  return body && typeof body === 'object' ? body : {};
}

const ERR_MSG = {
  term_length: 'Term 2 se 60 akshar ka hona chahiye.',
  text_length: 'Matlab 10 se 1500 akshar ka hona chahiye.',
  bad_chars: 'Term ya matlab mein < ya > nahi chalega.',
  too_many: 'Glossary mein zyada entries ho gayi hain.',
  store_failed: 'Save nahi ho paya. Thodi der baad try karein.',
  bad_term: 'Term sahi nahi hai.',
};

function createHandler(deps = {}) {
  const auth = deps.auth || createAdminAuth({ env: process.env, redis: upstash, mailer: createMailer() });
  const glossary = deps.glossary || glossaryLib.createGlossary({ redis: upstash });

  return async function glossaryHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const token = parseCookie(req.headers && req.headers.cookie, COOKIE);
      const session = await auth.checkSession(token);
      if (!session) return res.status(401).json({ ok: false, error: 'not_logged_in' });

      if (req.method === 'GET') {
        return res.status(200).json({ ok: true, entries: await glossary.list() });
      }
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        res.setHeader('Allow', 'GET, POST, DELETE');
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
      }
      if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'bad_origin' });

      if (req.method === 'POST') {
        const body = parseBody(req.body);
        const r = await glossary.save(body.term, body.text);
        if (!r.ok) return res.status(400).json({ ok: false, error: r.error, message: ERR_MSG[r.error] || 'Save nahi hua.' });
        return res.status(200).json({ ok: true, entry: r.entry, message: 'Save ho gaya. Chat mein turant lagu.' });
      }

      const term = queryParam(req, 'term');
      const r = await glossary.remove(term);
      if (!r.ok) return res.status(400).json({ ok: false, error: r.error, message: ERR_MSG[r.error] || 'Hata nahi paya.' });
      return res.status(200).json({ ok: true, removed: r.removed, message: r.removed ? 'Hata diya.' : 'Ye term mila nahi.' });
    } catch (e) {
      eh.logError(e, { where: 'admin-glossary' });
      return res.status(500).json({ ok: false, error: 'server_error', message: 'Kuch gadbad ho gayi.' });
    }
  };
}

const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
