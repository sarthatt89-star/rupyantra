'use strict';

/*
 * Rupeyantra Admin Auth (lib/admin-auth.js)
 * Admin login: email par 6-digit OTP, phir session cookie.
 *  - OTP sirf ADMIN_EMAIL (ya MAIL_ASK_ALLOWED) par jaata hai; Upstash mein HMAC ke roop mein.
 *  - OTP 5 min, 5 galat par 15 min lock, request cooldown 60s, ghante mein 5.
 *  - Session token 32 random bytes; store mein sirf HMAC. Cookie HttpOnly, Secure, SameSite=Strict.
 *  - Upstash ya secret na ho to login band (fail closed).
 *  - Store ke har zaroori write ka result check hota hai (slow Upstash par chupchap fail nahi).
 * Deps (tests): { env, redis: {isConfigured(), cmd(...), cmdWith?(opts, ...)}, mailer: {sendText()}, now, randomInt, randomBytes }
 */

const crypto = require('node:crypto');

const COOKIE = 'rp_admin';
const OTP_TTL_SEC = 300;
const OTP_MAX_ATTEMPTS = 5;
const REQUEST_COOLDOWN_SEC = 60;
const REQUESTS_PER_HOUR = 5;
const LOCK_TTL_SEC = 900;
const SESSION_TTL_SEC = 8 * 3600;
const MIN_SECRET_LENGTH = 24;
const STORE_TIMEOUT_MS = 4000;

const KEY = {
  otp: 'rp:admin:otp',
  cooldown: 'rp:admin:req:cooldown',
  hourly: 'rp:admin:req:hour',
  lock: 'rp:admin:lock',
};
const sessionKey = hash => 'rp:admin:sess:' + hash;

function createAdminAuth(deps = {}) {
  const env = deps.env || process.env;
  const redis = deps.redis;
  const mailer = deps.mailer;
  const now = deps.now || Date.now;
  const randomInt = deps.randomInt || crypto.randomInt;
  const randomBytes = deps.randomBytes || crypto.randomBytes;

  // Login ke liye lamba timeout (Upstash dheema ho to bhi OTP/session save ho)
  const run = (...a) => (redis && typeof redis.cmdWith === 'function'
    ? redis.cmdWith({ timeoutMs: STORE_TIMEOUT_MS }, ...a)
    : redis.cmd(...a));

  const secret = () => String(env.ADMIN_SESSION_SECRET || '').trim();
  const mac = value => crypto.createHmac('sha256', secret()).update(String(value)).digest('hex');
  const same = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  function adminEmail() {
    const first = String(env.ADMIN_EMAIL || env.MAIL_ASK_ALLOWED || '')
      .split(/[\s,;]+/)
      .find(Boolean) || '';
    const e = first.trim().toLowerCase();
    return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e) ? e : '';
  }

  function storeReady() {
    return Boolean(redis && redis.isConfigured() && secret().length >= MIN_SECRET_LENGTH);
  }

  function preflight() {
    const down = (error) => ({ status: 503, error, message: 'Login abhi available nahi hai.' });
    if (!redis || !redis.isConfigured()) return down('store_unavailable');
    if (secret().length < MIN_SECRET_LENGTH) return down('secret_not_configured');
    if (!adminEmail()) return down('admin_email_not_configured');
    if (!mailer) return down('mailer_unavailable');
    return null;
  }

  async function requestOtp() {
    const pre = preflight();
    if (pre) return pre;

    if (await run('GET', KEY.lock)) {
      return { status: 429, error: 'locked', message: 'Bahut galat koshish. Thodi der baad try karein.' };
    }
    if (await run('GET', KEY.cooldown)) {
      return { status: 429, error: 'cooldown', message: 'Ek minute baad dobara OTP mangwayein. Pehle wala OTP abhi bhi chalega.' };
    }
    const count = Number(await run('INCR', KEY.hourly)) || 0;
    if (count === 1) await run('EXPIRE', KEY.hourly, '3600');
    if (count > REQUESTS_PER_HOUR) {
      return { status: 429, error: 'hourly_limit', message: 'Ghante ki limit poori ho gayi. Baad mein try karein.' };
    }

    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const stored = await run(
      'SET', KEY.otp, JSON.stringify({ h: mac('otp:' + code), a: 0 }), 'EX', String(OTP_TTL_SEC)
    );
    if (stored !== 'OK') {
      return { status: 503, error: 'store_failed', message: 'Thodi der baad try karein.' };
    }

    const sent = await mailer.sendText(
      adminEmail(),
      'Rupeyantra admin login OTP',
      'Aapka OTP: ' + code + '\n\n5 minute mein expire ho jayega.\n' +
      'Sirf sabse naye email ka OTP chalega. Agar aapne login nahi kiya, to kuch na karein. Ye code kisi ko na batayein.'
    );
    if (!sent.ok) {
      await run('DEL', KEY.otp);
      return { status: 503, error: 'mail_failed', message: 'OTP email nahi gaya. Thodi der baad try karein.' };
    }
    // Cooldown sirf mail jaane ke baad: mail fail ho to turant dobara try kar sako
    await run('SET', KEY.cooldown, '1', 'EX', String(REQUEST_COOLDOWN_SEC));
    return { status: 200, ok: true, message: 'OTP aapke admin email par bhej diya gaya hai. Sirf naye email ka code daalein.' };
  }

  async function verifyOtp(input) {
    const pre = preflight();
    if (pre) return pre;

    if (await run('GET', KEY.lock)) {
      return { status: 429, error: 'locked', message: 'Bahut galat koshish. Thodi der baad try karein.' };
    }
    // spaces, dash, Hindi digits aur invisible characters hata do (copy-paste / keyboard se aate hain)
    const code = String(input || '')
      .replace(/[०-९]/g, d => String('०१२३४५६७८९'.indexOf(d)))
      .replace(/[\s\-\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '');
    if (!/^\d{6}$/.test(code)) {
      return { status: 400, error: 'bad_code', message: '6 digit ka OTP daalein.' };
    }

    let rec = null;
    try {
      rec = JSON.parse(await run('GET', KEY.otp));
    } catch (_) {
      rec = null;
    }
    if (!rec || typeof rec.h !== 'string') {
      return { status: 401, error: 'otp_missing', message: 'OTP expire ho gaya ya mila nahi. Naya OTP mangwayein.' };
    }

    if (same(mac('otp:' + code), rec.h)) {
      const token = randomBytes(32).toString('base64url');
      const email = adminEmail();
      // Pehle session save, tabhi OTP hatao: store fail ho to wahi OTP dobara chal sake
      const saved = await run(
        'SET', sessionKey(mac('sess:' + token)),
        JSON.stringify({ email, created: now() }), 'EX', String(SESSION_TTL_SEC)
      );
      if (saved !== 'OK') {
        return { status: 503, error: 'session_store_failed', message: 'Session save nahi ho paya. Wahi OTP dobara daalein.' };
      }
      await run('DEL', KEY.otp);
      await mailer.sendText(
        email,
        'Rupeyantra admin login hua',
        'Admin panel mein login hua: ' + new Date(now()).toISOString() + '\n' +
        'Agar ye aap nahi the, to turant ADMIN_SESSION_SECRET badlein.'
      );
      return { status: 200, ok: true, token, maxAge: SESSION_TTL_SEC, message: 'Login ho gaya.' };
    }

    const attempts = (Number(rec.a) || 0) + 1;
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await run('DEL', KEY.otp);
      await run('SET', KEY.lock, '1', 'EX', String(LOCK_TTL_SEC));
      return { status: 429, error: 'locked', message: 'Bahut galat koshish. 15 minute baad try karein.' };
    }
    await run('SET', KEY.otp, JSON.stringify({ h: rec.h, a: attempts }), 'EX', String(OTP_TTL_SEC));
    return {
      status: 401,
      error: 'wrong_code',
      message: 'OTP galat hai. Sirf sabse naye email ka code daalein.',
      left: OTP_MAX_ATTEMPTS - attempts,
    };
  }

  async function checkSession(token) {
    if (!storeReady() || typeof token !== 'string' || !token || token.length > 200) return null;
    const raw = await run('GET', sessionKey(mac('sess:' + token)));
    try {
      const s = JSON.parse(raw);
      return s && s.email ? { email: s.email, created: s.created } : null;
    } catch (_) {
      return null;
    }
  }

  async function destroySession(token) {
    if (!storeReady() || typeof token !== 'string' || !token || token.length > 200) return false;
    await run('DEL', sessionKey(mac('sess:' + token)));
    return true;
  }

  return { requestOtp, verifyOtp, checkSession, destroySession, adminEmail, preflight };
}

function parseCookie(header, name = COOKIE) {
  if (!header || typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return v && v.length <= 200 ? v : null;
    }
  }
  return null;
}

function serializeCookie(token, maxAge = SESSION_TTL_SEC) {
  return COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + maxAge;
}

function clearCookie() {
  return COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
}

module.exports = {
  createAdminAuth,
  parseCookie,
  serializeCookie,
  clearCookie,
  COOKIE,
  KEY,
  OTP_MAX_ATTEMPTS,
  REQUESTS_PER_HOUR,
};
