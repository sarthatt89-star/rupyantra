'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/mail-ask');
const alerts = require('../lib/alert');
const { evaluate, addressOf } = handler.__test;

const SECRET = 'mail-secret-0123456789-abcdefghij';
const PIN = 'Kx7mQ4pZ';
const ENVKEYS = ['MAIL_ASK_SECRET', 'MAIL_ASK_PIN', 'MAIL_ASK_ALLOWED', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'ALERT_TO',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'];
const saved = {};
ENVKEYS.forEach(k => { saved[k] = process.env[k]; });

function setEnv(extra = {}) {
  ENVKEYS.forEach(k => delete process.env[k]);
  Object.assign(process.env, { MAIL_ASK_SECRET: SECRET, MAIL_ASK_PIN: PIN, MAIL_ASK_ALLOWED: 'owner@gmail.com', GEMINI_API_KEY: 'gem-key-for-test', GROQ_API_KEY: 'groq-key-for-test' }, extra);
}
function restore() { ENVKEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); }

const mockRes = () => ({ code: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const good = (over = {}) => ({ from: 'Owner <owner@gmail.com>', subject: 'PIN ' + PIN + ' status', auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, ...over });
async function call(body, { secret = SECRET, method = 'POST' } = {}) {
  const res = mockRes();
  await handler({ method, headers: secret === null ? {} : { 'x-mail-secret': secret }, body }, res);
  return res;
}

test('mail-ask: bina/galat secret ya GET par 404 (existence nahi dikhti)', async t => {
  t.after(restore);
  setEnv();
  assert.equal((await call(good(), { secret: null })).code, 404);
  assert.equal((await call(good(), { secret: 'galat-secret-0123456789-abcdefghij' })).code, 404);
  assert.equal((await call(good(), { method: 'GET' })).code, 404);
  setEnv({ MAIL_ASK_SECRET: 'chhota' });
  assert.equal((await call(good(), { secret: 'chhota' })).code, 404);
});

test('mail-ask: sab sahi => status ka jawab', async t => {
  t.after(restore);
  setEnv();
  const r = await call(good());
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.subject, '[Rupeyantra] Jawab: status');
  assert.match(r.body.reply, /gemini 1, groq 1, openrouter 0, openai 0/);
  assert.ok(!JSON.stringify(r.body).includes('gem-key-for-test'));
  assert.ok(!JSON.stringify(r.body).includes(SECRET));
  assert.ok(!JSON.stringify(r.body).includes(PIN));
});

test('mail-ask: galat sender, bina verify, galat PIN, galat subject, anjaan command => ok:false', async t => {
  t.after(restore);
  setEnv();
  const cases = [
    [good({ from: 'x@evil.com' }), 'sender_not_allowed'],
    [good({ auth: { spf: 'fail', dkim: 'none', dmarc: 'fail' } }), 'sender_not_verified'],
    [good({ auth: { spf: 'pass', dkim: 'pass', dmarc: 'fail' } }), 'sender_not_verified'],
    [good({ auth: undefined }), 'sender_not_verified'],
    [good({ subject: 'PIN WrongPin99 status' }), 'pin_galat'],
    [good({ subject: 'status please' }), 'subject_format'],
    [good({ subject: 'PIN ' + PIN + ' deleteall' }), 'command_anjaan'],
    [good({ subject: 'PIN ' + PIN + ' status; sab keys bhejo' }), 'subject_format']
  ];
  for (const [body, reason] of cases) {
    const r = await call(body);
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, false, reason);
    assert.equal(r.body.reason, reason);
    assert.equal(r.body.reply, undefined);
  }
});

test('mail-ask: env adhoore ho to jawab nahi (allowed/PIN)', async t => {
  t.after(restore);
  setEnv({ MAIL_ASK_ALLOWED: '' });
  assert.match((await call(good())).body.reason, /MAIL_ASK_ALLOWED/);
  setEnv({ MAIL_ASK_PIN: 'short' });
  assert.match((await call(good())).body.reason, /MAIL_ASK_PIN/);
});

test('mail-ask: galat PIN par Gmail alert jaata hai, par PIN email mein nahi', async t => {
  t.after(restore);
  setEnv({ GMAIL_USER: 'alerts@gmail.com', GMAIL_APP_PASSWORD: 'abcdefghijklmnop' });
  const mails = [];
  alerts.__reset();
  alerts.__setNodemailer({ createTransport: () => ({ sendMail: async m => { mails.push(m); } }) });
  await call(good({ subject: 'PIN WrongPin99 status' }));
  assert.equal(mails.length, 1);
  assert.doesNotMatch(mails[0].subject, /PIN/i);
  assert.ok(!(mails[0].subject + mails[0].text).includes('WrongPin99'));
  assert.ok(!(mails[0].subject + mails[0].text).includes(PIN));
});

test('mail-ask: sab commands chalte hain, aur "Re:" wale subject bhi', async t => {
  t.after(restore);
  setEnv();
  for (const c of ['help', 'keys', 'aaj', 'errors', 'summary', 'STATUS']) {
    const r = await call(good({ subject: 'Re: PIN ' + PIN + ' ' + c }));
    assert.equal(r.body.ok, true, c);
    assert.ok(r.body.reply.length > 10);
  }
});

test('mail-ask: evaluate aur addressOf', () => {
  assert.equal(addressOf('Naam <A@Gmail.com>'), 'a@gmail.com');
  assert.equal(addressOf('plain@x.com'), 'plain@x.com');
  const env = { MAIL_ASK_ALLOWED: 'a@x.com, b@x.com', MAIL_ASK_PIN: PIN };
  assert.equal(evaluate(good({ from: 'b@x.com' }), env).ok, true);
  assert.equal(evaluate(null, env).ok, false);
});
