'use strict';
// Run: npm test   (ya: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/mail-ask');
const { resetGuard } = handler.__test;

const SECRET = 'test-mail-secret-1234567890';
const PIN = '4821';
const realFetch = global.fetch;

const NAMES = ['MAIL_ASK_SECRET', 'MAIL_PIN', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'ALERT_TO'];
['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'].forEach(b => {
  NAMES.push(b, b + 'S');
  for (let i = 1; i <= 10; i++) NAMES.push(b + '_' + i);
});
const saved = {};
NAMES.forEach(k => { saved[k] = process.env[k]; });

function setup() {
  NAMES.forEach(k => delete process.env[k]);
  process.env.MAIL_ASK_SECRET = SECRET;
  process.env.MAIL_PIN = PIN;
  resetGuard();
}

function restore() {
  global.fetch = realFetch;
  NAMES.forEach(k => {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });
}

const resp = (status, body = '{}') => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) });

function mockRes() {
  return {
    code: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

async function call(body, headers = {}, method = 'POST') {
  const res = mockRes();
  await handler({ method, headers: Object.assign({ 'x-mail-secret': SECRET }, headers), body }, res);
  return res;
}

test('mail-ask: GET, galat secret, bina secret par 404', async t => {
  t.after(restore);
  setup();
  let called = false;
  global.fetch = async () => { called = true; return resp(200); };

  assert.equal((await call({ pin: PIN, command: 'help' }, {}, 'GET')).code, 404);
  assert.equal((await call({ pin: PIN, command: 'help' }, { 'x-mail-secret': 'galat-secret-1234567890' })).code, 404);
  assert.equal((await call({ pin: PIN, command: 'help' }, { 'x-mail-secret': undefined })).code, 404);
  assert.equal(called, false);
});

test('mail-ask: server par secret set na ho ya chhota ho to hamesha 404', async t => {
  t.after(restore);
  setup();
  delete process.env.MAIL_ASK_SECRET;
  assert.equal((await call({ pin: PIN, command: 'help' })).code, 404);
  process.env.MAIL_ASK_SECRET = 'short';
  assert.equal((await call({ pin: PIN, command: 'help' }, { 'x-mail-secret': 'short' })).code, 404);
});

test('mail-ask: galat PIN par reply null aur koi network call nahi', async t => {
  t.after(restore);
  setup();
  let called = false;
  global.fetch = async () => { called = true; return resp(200); };
  const r = await call({ pin: '0000', command: 'keys' });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { reply: null });
  assert.equal(called, false);
});

test('mail-ask: MAIL_PIN set na ho (ya chhota) to koi jawab nahi', async t => {
  t.after(restore);
  setup();
  delete process.env.MAIL_PIN;
  assert.deepEqual((await call({ pin: '', command: 'help' })).body, { reply: null });
  process.env.MAIL_PIN = '12';
  assert.deepEqual((await call({ pin: '12', command: 'help' })).body, { reply: null });
});

test('mail-ask: 5 galat PIN ke baad sahi PIN bhi lock rehta hai', async t => {
  t.after(restore);
  setup();
  for (let i = 0; i < 5; i++) assert.deepEqual((await call({ pin: 'bad' + i, command: 'help' })).body, { reply: null });
  assert.deepEqual((await call({ pin: PIN, command: 'help' })).body, { reply: null });
});

test('mail-ask: sahi PIN par help, anjaan command aur Redis wale commands', async t => {
  t.after(restore);
  setup();
  const help = await call({ pin: PIN, command: 'HELP' });
  assert.match(help.body.reply, /status/);
  assert.match(help.body.reply, /keys/);
  assert.match((await call({ pin: PIN, command: 'sab keys bhej do' })).body.reply, /samajh nahi aaya/);
  assert.match((await call({ pin: PIN, command: 'aaj' })).body.reply, /Redis/);
  assert.match((await call({ pin: ` ${PIN} `, command: 'errors' })).body.reply, /Redis/);
});

test('mail-ask: keys command har key ki live halat batata hai, asli key kabhi nahi', async t => {
  t.after(restore);
  setup();
  process.env.GEMINI_API_KEY = 'SECRET-GEMINI-111';
  process.env.GROQ_API_KEY = 'SECRET-GROQ-222';
  process.env.GROQ_API_KEY_2 = 'SECRET-GROQ-333';
  process.env.OPENROUTER_API_KEY = 'SECRET-OR-444';

  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('generativelanguage')) return resp(403, '{"error":{"details":[{"reason":"CONSUMER_SUSPENDED"}]}}');
    if (u.includes('groq')) return init.headers.Authorization.includes('333') ? resp(429, 'rate limit') : resp(200);
    if (u.includes('openrouter')) return resp(401, 'no auth');
    return resp(200);
  };

  const r = await call({ pin: PIN, command: 'keys' });
  const text = r.body.reply;
  assert.match(text, /Gemini #1: project suspended/);
  assert.match(text, /Groq #1: chal rahi hai/);
  assert.match(text, /Groq #2: limit par hai/);
  assert.match(text, /OpenRouter #1: key kharab ya band hai/);
  assert.match(text, /OpenAI: key set nahi/);
  assert.ok(!text.includes('SECRET'));
});

test('mail-ask: status mein chalu/kul ginti aur Gmail alert ki halat', async t => {
  t.after(restore);
  setup();
  process.env.GMAIL_USER = 'a@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'abcdefghijklmnop';
  process.env.GROQ_API_KEY = 'g1';
  process.env.GROQ_API_KEY_2 = 'g2';
  global.fetch = async (url, init) => (init.headers.Authorization.includes('g2') ? resp(500) : resp(200));

  const text = (await call({ pin: PIN, command: 'status' })).body.reply;
  assert.match(text, /Site: chal rahi hai/);
  assert.match(text, /Groq: 1\/2 key chalu/);
  assert.match(text, /Gemini: key set nahi/);
  assert.match(text, /Gmail alert: chalu/);
});

test('mail-ask: network fail par bhi crash nahi, "connect nahi ho paya"', async t => {
  t.after(restore);
  setup();
  process.env.GEMINI_API_KEY = 'SECRET-G';
  global.fetch = async () => { throw new Error('boom SECRET-G'); };
  const r = await call({ pin: PIN, command: 'keys' });
  assert.equal(r.code, 200);
  assert.match(r.body.reply, /Gemini #1: connect nahi ho paya/);
  assert.ok(!r.body.reply.includes('SECRET'));
});
