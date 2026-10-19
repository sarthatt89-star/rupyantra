'use strict';

/*
 * Rupeyantra Mailer (lib/mailer.js)
 *
 * Admin OTP aur login alert ke liye ek chhota, text-only mailer.
 * Gmail ke wahi env use karta hai jo alert.js karta hai: GMAIL_USER, GMAIL_APP_PASSWORD.
 * Kabhi throw nahi karta; { ok, reason } lautata hai. Password kabhi log nahi hota.
 */

const SEND_TIMEOUT_MS = 8000;

function createMailer(deps = {}) {
  const env = deps.env || process.env;
  let nodemailer = deps.nodemailer || null;

  const config = () => {
    const user = String(env.GMAIL_USER || '').trim();
    const pass = String(env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
    return user && pass ? { user, pass } : null;
  };

  async function sendText(to, subject, text) {
    try {
      const cfg = config();
      if (!cfg) return { ok: false, reason: 'not_configured' };
      if (!to) return { ok: false, reason: 'no_recipient' };
      if (!nodemailer) nodemailer = require('nodemailer');

      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: cfg.user, pass: cfg.pass },
      });

      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('mail timeout')), SEND_TIMEOUT_MS);
      });
      try {
        await Promise.race([
          transporter.sendMail({ from: 'Rupeyantra Admin <' + cfg.user + '>', to, subject, text }),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: 'error' };
    }
  }

  return { sendText, config };
}

module.exports = { createMailer };
