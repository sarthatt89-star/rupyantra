'use strict';

/*
 * Rupeyantra Gmail Alerts (lib/alert.js)
 *
 * Koi zaroori dikkat ho (key kharab, limit khatam, saare AI fail...) to aapko Gmail par email.
 *
 * Vercel env (teeno hone chahiye, warna alert chupchap band rehta hai):
 *   GMAIL_USER          = aapka Gmail address (bhejne wala)
 *   GMAIL_APP_PASSWORD  = Google ka 16-akshar ka App Password (normal password nahi)
 *   ALERT_TO            = jis Gmail par alert chahiye (na do to GMAIL_USER par jaata hai)
 *
 * Niyam (tests/alert.test.js mein lock):
 *  - Kabhi throw nahi karta, aur site ko dheema nahi karta (timeout ke baad chhod deta hai).
 *  - Throttle: ek hi alert 30 min (URGENT) / 60 min (WARNING) mein sirf ek baar; ghante mein max 10 email
 *    (opts.force sirf per-alert throttle hatata hai, ghante ki limit nahi; test link ke liye).
 *  - Email mein API key, password, user ka chat/text kabhi nahi: sirf error ka naam, provider, kab.
 *  - Throttle ki yaad ek chalte Vercel instance ki memory mein rehti hai (restart par reset).
 *  - nodemailer sirf email bhejte waqt load hota hai (package.json mein dependency chahiye).
 */

const eh = require('./error-handler');

const LEVELS = {
  urgent: { tag: 'URGENT', throttleMs: 30 * 60 * 1000 },
  warning: { tag: 'WARNING', throttleMs: 60 * 60 * 1000 },
  info: { tag: 'INFO', throttleMs: 6 * 60 * 60 * 1000 }
};

const HOURLY_CAP = 10;
const DEFAULT_TIMEOUT_MS = 4000;
const SECRET_KEY_RE = /key|token|password|passwd|secret|authorization|cookie|message|content|text|prompt|chat|body/i;

function cleanDetails(details) {
  const out = {};
  if (!details || typeof details !== 'object') return out;
  for (const [k, v] of Object.entries(details).slice(0, 20)) {
    if (SECRET_KEY_RE.test(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = eh.sanitize(v, { maxLen: 200 });
  }
  return out;
}

function createAlerter(deps = {}) {
  const env = deps.env || process.env;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  let nodemailer = deps.nodemailer || null;
  let transporter = null;
  let transporterFor = '';
  const last = new Map();
  let sentTimes = [];

  const config = () => {
    const user = String(env.GMAIL_USER || '').trim();
    const pass = String(env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
    const to = String(env.ALERT_TO || '').trim() || user;
    return user && pass && to ? { user, pass, to } : null;
  };

  const isConfigured = () => Boolean(config());

  function getTransporter(cfg) {
    const id = cfg.user + '|' + cfg.pass.length;
    if (transporter && transporterFor === id) return transporter;
    if (!nodemailer) nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: cfg.user, pass: cfg.pass }
    });
    transporterFor = id;
    return transporter;
  }

  // level: 'urgent' | 'warning' | 'info'. Hamesha { sent, reason } lautata hai; kabhi throw nahi.
  async function sendAlert(level, title, details = {}, opts = {}) {
    try {
      const lv = LEVELS[level] || LEVELS.warning;
      const cfg = config();
      if (!cfg) return { sent: false, reason: 'not_configured' };

      const safeTitle = eh.sanitize(title, { maxLen: 120 }) || 'Alert';
      const safe = cleanDetails(details);
      const t = now();

      const key = lv.tag + '|' + safeTitle + '|' + (safe.provider || '') + '|' + (safe.slot || '');
      const prev = last.get(key);
      if (!opts.force && prev !== undefined && t - prev < lv.throttleMs) return { sent: false, reason: 'throttled' };

      sentTimes = sentTimes.filter(x => t - x < 3600000);
      if (sentTimes.length >= HOURLY_CAP) return { sent: false, reason: 'cap' };

      last.set(key, t);
      if (last.size > 200) last.delete(last.keys().next().value);
      sentTimes.push(t);

      const when = new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const lines = [
        'Level: ' + lv.tag,
        'Kab: ' + when + ' (IST)',
        'Kya hua: ' + safeTitle,
        ...Object.entries(safe).map(([k, v]) => k + ': ' + v),
        '',
        'Detail ke liye Vercel > Project > Logs dekho (Request ID se dhundho).',
        'Ye email apne aap bheji gayi hai. Isme koi API key ya user ka chat nahi hota.'
      ];

      const mailer = getTransporter(cfg);
      const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
      let timer;
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('alert email timeout')), timeoutMs); });
      try {
        await Promise.race([
          mailer.sendMail({
            from: 'Rupeyantra Alerts <' + cfg.user + '>',
            to: cfg.to,
            subject: '[' + lv.tag + '] Rupeyantra: ' + safeTitle,
            text: lines.join('\n')
          }),
          timeout
        ]);
      } finally {
        clearTimeout(timer);
      }
      return { sent: true, reason: 'ok' };
    } catch (e) {
      const detail = eh.sanitize(e && e.message ? e.message : String(e), { maxLen: 200 });
      try { console.error('[alert] email nahi gayi: ' + detail); } catch (_) { /* ignore */ }
      return { sent: false, reason: 'error', detail };
    }
  }

  return {
    sendAlert,
    isConfigured,
    __setNodemailer(n) { nodemailer = n; transporter = null; transporterFor = ''; },
    __reset() { last.clear(); sentTimes = []; transporter = null; transporterFor = ''; }
  };
}

const defaultAlerter = createAlerter();

module.exports = {
  sendAlert: defaultAlerter.sendAlert,
  isConfigured: defaultAlerter.isConfigured,
  __setNodemailer: defaultAlerter.__setNodemailer,
  __reset: defaultAlerter.__reset,
  createAlerter,
  LEVELS
};

