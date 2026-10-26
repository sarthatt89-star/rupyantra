'use strict';

/*
 * Rupeyantra Mail Ask (api/mail-ask.js)
 *
 * Gmail ka Apps Script (apps-script/Code.gs) yahan mail ki jaankari bhejta hai; ye tay commands ka jawab lautata hai.
 * Is raaste ko seedha koi nahi khol sakta: bina MAIL_ASK_SECRET ke har cheez par 404.
 *
 * Vercel env (Secret type):
 *   MAIL_ASK_SECRET   = lamba random text (kam se kam 24 akshar); sirf Vercel aur Apps Script ko pata
 *   MAIL_ASK_PIN      = aapka PIN (kam se kam 8 akshar/numbers); mail ke subject mein likhna hota hai
 *   MAIL_ASK_ALLOWED  = jis address se command aayegi (comma se kai ho sakte hain)
 *
 * Jaanch (sab pass hone par hi jawab):
 *   1. secret sahi  2. sender allowed  3. Gmail ne sender verify kiya (SPF ya DKIM pass)
 *   4. subject "PIN <pin> <command>"  5. PIN sahi  6. command tay list mein
 * Galat par kuch nahi hota (script chup rehti hai). Mail ka text kabhi AI ko nahi jaata.
 */

const crypto = require('node:crypto');
const eh = require('../lib/error-handler');
const providers = require('../lib/providers');
const alerts = require('../lib/alert');
const stats = require('../lib/stats');
const commands = require('../lib/mail-commands');

const MAX_PER_HOUR = 60;
let times = [];

const sha = v => crypto.createHash('sha256').update(String(v)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const addressOf = from => {
  const m = String(from || '').match(/<([^<>\s]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
};

function evaluate(body, env = process.env) {
  const allowed = String(env.MAIL_ASK_ALLOWED || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return { ok: false, reason: 'MAIL_ASK_ALLOWED set nahi hai' };
  const pin = String(env.MAIL_ASK_PIN || '').trim();
  if (pin.length < 8) return { ok: false, reason: 'MAIL_ASK_PIN set nahi hai ya 8 akshar se chhota hai' };

  const b = body && typeof body === 'object' ? body : {};
  if (!allowed.includes(addressOf(b.from))) return { ok: false, reason: 'sender_not_allowed' };

  const auth = b.auth && typeof b.auth === 'object' ? b.auth : {};
  const verified = (auth.dkim === 'pass' || auth.spf === 'pass') && auth.dmarc !== 'fail';
  if (!verified) return { ok: false, reason: 'sender_not_verified' };

  const m = String(b.subject || '').match(/^\s*(?:re:\s*)?PIN\s+(\S{1,64})\s+([A-Za-z]{2,20})\s*$/i);
  if (!m) return { ok: false, reason: 'subject_format' };
  if (!same(m[1], pin)) return { ok: false, reason: 'pin_galat' };

  const command = commands.normalize(m[2]);
  if (!command) return { ok: false, reason: 'command_anjaan' };
  return { ok: true, command };
}

// Har provider ki keys ki ginti (sirf ginti, keys kabhi nahi)
function poolSummaries() {
  const pools = providers.makePools(process.env);
  const out = {};
  for (const p of providers.NAMES) out[p] = pools[p].summary();
  return out;
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = String(process.env.MAIL_ASK_SECRET || '').trim();
  const supplied = req.headers && req.headers['x-mail-secret'];
  const notFound = () => res.status(404).json({ error: 'NOT_FOUND' });

  if (req.method !== 'POST' || secret.length < 24 || typeof supplied !== 'string' || !same(supplied.trim(), secret)) {
    return notFound();
  }

  const now = Date.now();
  times = times.filter(t => now - t < 3600000);
  if (times.length >= MAX_PER_HOUR) return res.status(200).json({ ok: false, reason: 'ghante ki limit' });
  times.push(now);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }

  const v = evaluate(body);
  if (!v.ok) {
    if (v.reason === 'pin_galat' || v.reason === 'sender_not_verified') {
      await alerts.sendAlert('warning', 'Mail se kisi ne galat code ke saath koshish ki', { kind: v.reason }, { timeoutMs: 3000 });
    }
    return res.status(200).json({ ok: false, reason: v.reason });
  }

  const result = await commands.run(v.command, {
    stats,
    pools: poolSummaries(),
    alertsConfigured: alerts.isConfigured()
  });
  await stats.record({ ['mail_ask.' + v.command]: 1 });
  return res.status(200).json({ ok: true, subject: '[Rupeyantra] Jawab: ' + v.command, reply: result.reply });
}

module.exports = eh.wrapHandler(handler, { where: 'mail-ask' });
module.exports.__test = { evaluate, addressOf };
