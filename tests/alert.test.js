'use strict';
// Run: npm test   (ya: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlerter } = require('../lib/alert');

const ENV = { GMAIL_USER: 'alerts@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop', ALERT_TO: 'owner@gmail.com' };

function setup(env = ENV, now) {
  const mails = [];
  const authSeen = [];
  const fake = {
    createTransport: cfg => { authSeen.push(cfg.auth); return { sendMail: async m => { mails.push(m); } }; }
  };
  const clock = { t: 1700000000000 };
  const a = createAlerter({ env, nodemailer: fake, now: now || (() => clock.t) });
  return { a, mails, authSeen, clock };
}

test('alert: env na ho to chupchap band (email nahi, error nahi)', async () => {
  const { a, mails } = setup({});
  assert.equal(a.isConfigured(), false);
  assert.deepEqual(await a.sendAlert('urgent', 'x'), { sent: false, reason: 'not_configured' });
  assert.equal(mails.length, 0);
});

test('alert: email sahi subject/to/from ke saath jaati hai, app password ke spaces hat jaate hain', async () => {
  const { a, mails, authSeen } = setup();
  const r = await a.sendAlert('urgent', 'Saare AI providers fail ho gaye', { provider: 'Gemini', requestId: 'req_123456' });
  assert.equal(r.sent, true);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, '[URGENT] Rupeyantra: Saare AI providers fail ho gaye');
  assert.equal(mails[0].to, 'owner@gmail.com');
  assert.match(mails[0].from, /alerts@gmail\.com/);
  assert.match(mails[0].text, /provider: Gemini/);
  assert.match(mails[0].text, /req_123456/);
  assert.equal(authSeen[0].pass, 'abcdefghijklmnop');
});

test('alert: ALERT_TO na ho to GMAIL_USER par jaati hai', async () => {
  const { a, mails } = setup({ GMAIL_USER: 'me@gmail.com', GMAIL_APP_PASSWORD: 'pppppppppppppppp' });
  await a.sendAlert('warning', 'kuch');
  assert.equal(mails[0].to, 'me@gmail.com');
});

test('alert: throttle (urgent 30 min), force, aur alag alert alag ginti', async () => {
  const { a, mails, clock } = setup();
  assert.equal((await a.sendAlert('urgent', 'Key kharab', { provider: 'Gemini' })).sent, true);
  assert.deepEqual(await a.sendAlert('urgent', 'Key kharab', { provider: 'Gemini' }), { sent: false, reason: 'throttled' });
  assert.equal((await a.sendAlert('urgent', 'Key kharab', { provider: 'Groq' })).sent, true); // doosra provider
  assert.equal((await a.sendAlert('urgent', 'Key kharab', { provider: 'Gemini' }, { force: true })).sent, true);
  clock.t += 31 * 60 * 1000;
  assert.equal((await a.sendAlert('urgent', 'Key kharab', { provider: 'Gemini' })).sent, true);
  assert.equal(mails.length, 4);
  // warning ki throttle lambi (60 min)
  assert.equal((await a.sendAlert('warning', 'Limit', {})).sent, true);
  clock.t += 31 * 60 * 1000;
  assert.equal((await a.sendAlert('warning', 'Limit', {})).reason, 'throttled');
});

test('alert: ghante mein maximum 10 email', async () => {
  const { a, mails, clock } = setup();
  for (let i = 0; i < 14; i++) await a.sendAlert('urgent', 'alert number ' + i);
  assert.equal(mails.length, 10);
  assert.equal((await a.sendAlert('urgent', 'aur ek')).reason, 'cap');
  clock.t += 61 * 60 * 1000;
  assert.equal((await a.sendAlert('urgent', 'ghanta baad')).sent, true);
});

test('alert: email mein key, password aur user ka text kabhi nahi', async () => {
  const { a, mails } = setup();
  await a.sendAlert('urgent', 'Dikkat gsk_' + 'a1B2c3D4'.repeat(4), {
    provider: 'Groq',
    apiKey: 'SECRET-KEY-1',
    token: 'SECRET-TOKEN-2',
    messages: 'USER-CHAT-3',
    content: 'USER-CHAT-4',
    text: 'USER-CHAT-5',
    errorType: 'rate_limit',
    detail: 'Bearer abcdefghijklmnop12345 aur AIza' + 'Xy9Zw8Vu7Ts6Rq5Po4'.repeat(2)
  });
  const body = mails[0].subject + '\n' + mails[0].text;
  for (const leak of ['SECRET-KEY', 'SECRET-TOKEN', 'USER-CHAT', 'gsk_a1B2', 'abcdefghijklmnop12345', 'AIzaXy9Z', 'abcdefghijklmnop']) {
    assert.ok(!body.includes(leak), 'leak: ' + leak);
  }
  assert.match(body, /errorType: rate_limit/);
});

test('alert: email bhejna fail/slow ho to throw nahi karta, site ko nahi rokta', async () => {
  const failing = createAlerter({ env: ENV, nodemailer: { createTransport: () => ({ sendMail: async () => { throw new Error('Invalid login: 535 BadCredentials'); } }) } });
  const r1 = await failing.sendAlert('urgent', 'x');
  assert.equal(r1.sent, false);
  assert.equal(r1.reason, 'error');
  assert.match(r1.detail, /Invalid login/);

  const slow = createAlerter({ env: ENV, nodemailer: { createTransport: () => ({ sendMail: () => new Promise(() => {}) }) } });
  const started = Date.now();
  const r2 = await slow.sendAlert('urgent', 'x', {}, { timeoutMs: 60 });
  assert.equal(r2.reason, 'error');
  assert.match(r2.detail, /timeout/);
  assert.ok(Date.now() - started < 1500);
});
