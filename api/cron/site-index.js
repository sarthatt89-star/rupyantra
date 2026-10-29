'use strict';

/*
 * Site index cron (api/cron/site-index.js)
 *   GET /api/cron/site-index  -> site ke pages dobara padh kar index banata hai
 * Vercel Cron khud "Authorization: Bearer <CRON_SECRET>" bhejta hai. CRON_SECRET (kam se kam 16 akshar) set na ho to ye band rehta hai.
 * Env: CRON_SECRET (zaroori), SITE_URL (optional, jaise https://rupyantra-psi.vercel.app)
 */

const crypto = require('node:crypto');
const siteIndex = require('../../lib/site-index');
const eh = require('../../lib/error-handler');

const clean = v => String(v === undefined || v === null ? '' : v).trim().replace(/^["']+|["']+$/g, '').trim();

function authorized(req) {
  const secret = clean(process.env.CRON_SECRET);
  if (secret.length < 16) return { ok: false, status: 503, error: 'cron_secret_missing' };
  const header = String((req.headers && req.headers.authorization) || '');
  const got = header.replace(/^Bearer\s+/i, '').trim();
  const h = v => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(h(secret), h(got))
    ? { ok: true }
    : { ok: false, status: 401, error: 'unauthorized' };
}

module.exports = async function siteIndexCron(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const a = authorized(req);
  if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error });

  try {
    const base = clean(process.env.SITE_URL) || 'https://' + (req.headers && req.headers.host);
    const r = await siteIndex.crawl(base);
    return res.status(200).json(r);
  } catch (e) {
    eh.logError(e, { where: 'site-index-cron' });
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
};
