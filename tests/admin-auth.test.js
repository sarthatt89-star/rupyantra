'use strict';
// Run: npm test   (ya: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAdminAuth, parseCookie, serializeCookie, clearCookie, KEY, OTP_MAX_ATTEMPTS, REQUESTS_PER_HOUR,
} = require('../lib/admin-auth');
const { createHandler } = require('../api/admin/auth');

const SECRET = 'admin-test-secret-0123456789abcdef';
const EMAIL = 'owner@gmail.com';

function fakeRedis({ down = false } = {}) {
  const data = new Map();
  return {
    data,
    isConfigured: () => !down,
    async cmd(...a) {
      if (down) return null;
      const [op, k, ...rest] = a;
      switch (op) {
        case 'GET': return data.has(k) ? data.get(k) : null;
        case 'SET': data.set(k, String(rest[0])); return 'OK';
        case 'DEL': return data.delete(k) ? 1 : 0;
        case 'INCR': { const v = Number(data.get(k) || 0) + 1; data.set(k, String(v)); return v; }
        case 'EXPIRE': return 1;
        default: throw new Error('unsupported ' + op);
      }
    },
  };
}

function fakeMailer() {
  return {
    sent: [],
    async sendText(to, subject, text) { this.sent.push({ to, subject, text }); return { ok: true }; },
  };
}

function setup({ env = {}, code = 123456, redisDown = false, mailerOk = true } = {}) {
  const redis = fakeRedis({ down: redisDown });
  const mailer = fakeMailer();
  if (!mailerOk) mailer.sendText = async () => ({ ok: false, reason: 'error' });
  const auth = createAdminAuth({
    env: { ADMIN_SESSION_SECRET: SECRET, ADMIN_EMAIL: EMAIL, ...env },
    redis, mailer,
    randomInt: () => code,
    randomBytes: () => Buffer.alloc(32, 7),
    now: () => Date.parse('2026-10-19T10:00:00Z'),
  });
  return { auth, redis, mailer };
}

const otpFromMail = mailer => mailer.sent[0].text.match(/OTP: (\d{6})/)[1];

test('preflight: secret, email, store ya mailer na ho to login band', async () => {
  assert.equal((await setup({ env: { ADMIN_SESSION_SECRET: 'short' } }).auth.requestOtp()).status, 503);
  assert.equal((await setup({ env: { ADMIN_EMAIL: '', MAIL_ASK_ALLOWED: '' } }).auth.requestOtp()).status, 503);
  assert.equal((await setup({ redisDown: true }).auth.requestOtp()).status, 503);
});

test('request: admin email par 6-digit OTP jaata hai; Upstash mein plain OTP nahi', async () => {
  const { auth, redis, mailer } = setup({ code: 4821 });
  const r = await auth.requestOtp();
  assert.equal(r.status, 200);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, EMAIL);
  assert.equal(otpFromMail(mailer), '004821');
  const rec = JSON.parse(redis.data.get(KEY.otp));
  assert.deepEqual(Object.keys(rec).sort(), ['a', 'h']);
  assert.ok(!redis.data.get(KEY.otp).includes('004821'));
});

test('request: 60 second cooldown, aur ghante mein limit', async () => {
  const { auth, redis } = setup();
  assert.equal((await auth.requestOtp()).status, 200);
  assert.equal((await auth.requestOtp()).status, 429);
  for (let i = 1; i < REQUESTS_PER_HOUR; i++) {
    redis.data.delete(KEY.cooldown);
    assert.equal((await auth.requestOtp()).status, 200);
  }
  redis.data.delete(KEY.cooldown);
  assert.equal((await auth.requestOtp()).error, 'hourly_limit');
});

test('request: mail fail ho to OTP hata diya jata hai', async () => {
  const { auth, redis } = setup({ mailerOk: false });
  const r = await auth.requestOtp();
  assert.equal(r.status, 503);
  assert.equal(redis.data.has(KEY.otp), false);
});

test('verify: sahi OTP par session banta hai, token hash ho kar store hota hai, alert mail jaata hai', async () => {
  const { auth, redis, mailer } = setup({ code: 111222 });
  await auth.requestOtp();
  const v = await auth.verifyOtp('111222');
  assert.equal(v.status, 200);
  assert.ok(v.token && v.token.length > 30);
  assert.equal(redis.data.has(KEY.otp), false);
  for (const k of redis.data.keys()) assert.ok(!k.includes(v.token));
  assert.deepEqual((await auth.checkSession(v.token)).email, EMAIL);
  assert.equal(mailer.sent.at(-1).subject, 'Rupeyantra admin login hua');
  assert.equal((await auth.verifyOtp('111222')).error, 'otp_missing');
});

test('verify: galat OTP par baaki koshish ginti; 5 galat par lock', async () => {
  const { auth, redis } = setup({ code: 999999 });
  await auth.requestOtp();
  let last;
  for (let i = 1; i < OTP_MAX_ATTEMPTS; i++) {
    last = await auth.verifyOtp('000000');
    assert.equal(last.status, 401);
    assert.equal(last.left, OTP_MAX_ATTEMPTS - i);
  }
  last = await auth.verifyOtp('000000');
  assert.equal(last.status, 429);
  assert.equal(redis.data.has(KEY.lock), true);
  assert.equal((await auth.requestOtp()).status, 429);
  assert.equal((await auth.verifyOtp('999999')).status, 429);
});

test('verify: bina sahi format ya expire OTP par saaf jawab', async () => {
  const { auth, redis } = setup();
  assert.equal((await auth.verifyOtp('12ab')).status, 400);
  assert.equal((await auth.verifyOtp('123456')).error, 'otp_missing');
  await auth.requestOtp();
  redis.data.delete(KEY.otp);
  assert.equal((await auth.verifyOtp('123456')).error, 'otp_missing');
});

test('session: galat token par null; logout ke baad session khatam', async () => {
  const { auth } = setup({ code: 555555 });
  await auth.requestOtp();
  const v = await auth.verifyOtp('555555');
  assert.equal(await auth.checkSession('galat-token'), null);
  assert.equal(await auth.checkSession(undefined), null);
  await auth.destroySession(v.token);
  assert.equal(await auth.checkSession(v.token), null);
});

test('cookie: parse, set aur clear', () => {
  assert.equal(parseCookie('a=1; rp_admin=abc123; b=2', 'rp_admin'), 'abc123');
  assert.equal(parseCookie('x=1', 'rp_admin'), null);
  assert.equal(parseCookie(undefined), null);
  const set = serializeCookie('tok', 28800);
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Strict/);
  assert.match(clearCookie(), /Max-Age=0/);
});

/* ---------- HTTP handler ---------- */

function mockRes() {
  return {
    code: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const call = (handler, { method = 'POST', action, body, headers = {} } = {}) => {
  const res = mockRes();
  return handler({
    method, query: { action }, body,
    headers: { host: 'rupyantra-psi.vercel.app', origin: 'https://rupyantra-psi.vercel.app', ...headers },
  }, res).then(() => res);
};

test('handler: request, verify, session aur logout poore flow mein kaam karte hain', async () => {
  const { auth, mailer } = setup({ code: 777888 });
  const handler = createHandler({ auth });

  const noSession = await call(handler, { method: 'GET', action: 'session' });
  assert.equal(noSession.code, 401);

  const req = await call(handler, { action: 'request' });
  assert.equal(req.code, 200);
  assert.ok(!JSON.stringify(req.body).includes('777888'));

  const bad = await call(handler, { action: 'verify', body: { code: '000000' } });
  assert.equal(bad.code, 401);
  assert.equal(bad.body.left, OTP_MAX_ATTEMPTS - 1);

  const ok = await call(handler, { action: 'verify', body: JSON.stringify({ code: '777888' }) });
  assert.equal(ok.code, 200);
  const cookie = ok.headers['Set-Cookie'];
  assert.match(cookie, /^rp_admin=/);
  assert.ok(!JSON.stringify(ok.body).includes('rp_admin'));

  const token = cookie.split(';')[0].split('=')[1];
  const session = await call(handler, { method: 'GET', action: 'session', headers: { cookie: 'rp_admin=' + token } });
  assert.equal(session.code, 200);
  assert.equal(session.body.email, EMAIL);

  const out = await call(handler, { action: 'logout', headers: { cookie: 'rp_admin=' + token } });
  assert.equal(out.code, 200);
  assert.match(out.headers['Set-Cookie'], /Max-Age=0/);
  const after = await call(handler, { method: 'GET', action: 'session', headers: { cookie: 'rp_admin=' + token } });
  assert.equal(after.code, 401);
  assert.ok(mailer.sent.length >= 2);
});

test('handler: galat origin, galat method aur anjaan action block', async () => {
  const { auth } = setup();
  const handler = createHandler({ auth });
  assert.equal((await call(handler, { action: 'request', headers: { origin: 'https://evil.example' } })).code, 403);
  assert.equal((await call(handler, { method: 'GET', action: 'request' })).code, 405);
  assert.equal((await call(handler, { method: 'POST', action: 'hack' })).code, 404);
});

test('handler: store down ho to user ko saaf message, koi stack/key nahi', async () => {
  const { auth } = setup({ redisDown: true });
  const handler = createHandler({ auth });
  const res = await call(handler, { action: 'request' });
  assert.equal(res.code, 503);
  assert.ok(!/secret|token|stack|upstash/i.test(JSON.stringify(res.body)));
});
