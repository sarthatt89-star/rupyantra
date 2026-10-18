'use strict';
// Run: npm test   (ya: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/finance-engine');
const handler = require('../api/chat');
const { post, answerWith, limited, sanitize } = handler.__test;

const realFetch = global.fetch;

// Har provider ki saari key env names (base, _1.._10, list): tests ke liye inhe saaf rakhna zaroori hai
const BASES = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'];
const KEYS = ['DEBUG_ERRORS', 'GEMINI_MODEL', 'GEMINI_SEARCH_MODEL', 'OPENAI_MODEL', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'ALERT_TO', 'ADMIN_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
BASES.forEach(b => {
  KEYS.push(b, b + 'S');
  for (let i = 1; i <= 10; i++) KEYS.push(b + '_' + i);
});
const savedEnv = {};
KEYS.forEach(k => { savedEnv[k] = process.env[k]; });

function clearKeys() {
  KEYS.forEach(k => delete process.env[k]);
}

function reset() {
  global.fetch = realFetch;
  KEYS.forEach(k => {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  });
}

const okRes = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
const badRes = (status, text = '') => ({ ok: false, status, headers: { get: () => null }, json: async () => ({}), text: async () => text });
const geminiText = text => okRes({ candidates: [{ content: { parts: [{ text }] } }] });
const groqText = text => okRes({ choices: [{ message: { role: 'assistant', content: text } }] });

function mockRes() {
  return {
    code: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

let ipCounter = 0;
const req = (messages, extra = {}) => ({
  method: 'POST',
  headers: { 'x-forwarded-for': '10.0.0.' + (++ipCounter) },
  body: { messages },
  ...extra
});

/* ---------- sanitize ---------- */

test('sanitize: leading assistant dropped, old attachments removed, default text added', () => {
  const att = { mime: 'image/png', data: 'AAAA' };
  const out = sanitize([
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'pehla', attachments: [att] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '', attachments: [att] }
  ]);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].attachments, undefined);
  assert.ok(out[out.length - 1].attachments.length === 1);
  assert.ok(out[out.length - 1].content.length > 0);
});

test('sanitize: invalid mime, bad base64 and junk messages are dropped', () => {
  const out = sanitize([
    null,
    { role: 'system', content: 'x' },
    { role: 'user', content: 'hi', attachments: [{ mime: 'text/html', data: 'AAAA' }, { mime: 'image/png', data: 'not base64!' }] }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].attachments, undefined);
});

/* ---------- post: retry / timeout ---------- */

test('post: retries once on 503 and then succeeds', async t => {
  t.after(reset);
  let n = 0;
  global.fetch = async () => (++n === 1 ? badRes(503) : okRes({ ok: 1 }));
  const r = await post('T', 'http://x', {}, {}, Date.now() + 10000);
  assert.equal(r.ok, true);
  assert.equal(n, 2);
});

test('post: no retry on 400', async t => {
  t.after(reset);
  let n = 0;
  global.fetch = async () => { n++; return badRes(400, 'bad'); };
  await assert.rejects(post('T', 'http://x', {}, {}, Date.now() + 10000), /HTTP 400/);
  assert.equal(n, 1);
});

test('post: gives up after retries on persistent 500', async t => {
  t.after(reset);
  let n = 0;
  global.fetch = async () => { n++; return badRes(500); };
  await assert.rejects(post('T', 'http://x', {}, {}, Date.now() + 10000), /HTTP 500/);
  assert.equal(n, 2);
});

test('post: 429 retries on same key normally, but not when fast (agli key available)', async t => {
  t.after(reset);
  let n = 0;
  global.fetch = async () => { n++; return badRes(429, 'rate limit'); };
  await assert.rejects(post('T', 'http://x', {}, {}, Date.now() + 10000, 15000, true), /HTTP 429/);
  assert.equal(n, 1);
});

test('post: timeout is reported as timeout', async t => {
  t.after(reset);
  global.fetch = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  await assert.rejects(post('T', 'http://x', {}, {}, Date.now() + 10000), /timeout/i);
});

test('post: expired deadline fails fast without calling fetch', async t => {
  t.after(reset);
  let n = 0;
  global.fetch = async () => { n++; return okRes({}); };
  await assert.rejects(post('T', 'http://x', {}, {}, Date.now() + 100));
  assert.equal(n, 0);
});

/* ---------- rate limit ---------- */

test('limited: 11th request in a minute from one IP is blocked', () => {
  const ip = 'rl-test-ip';
  for (let i = 0; i < 10; i++) assert.equal(limited(ip), false);
  assert.equal(limited(ip), true);
  assert.equal(limited('another-ip'), false);
});

/* ---------- answerWith: verification + tool enforcement ---------- */

const EMI_ARGS = { principal: 5000000, annual_rate: 8.5, years: 20 };
const EMI_MSG = [{ role: 'user', content: '50 lakh ka home loan 8.5% par 20 saal ke liye EMI kitni hogi?' }];
const emiCall = () => ({ name: 'calc_emi', args: EMI_ARGS, result: engine.runTool('calc_emi', EMI_ARGS) });
const envFor = messages => ({ ctx: engine.buildContext(messages), verification: undefined, hasMedia: false, deadline: Date.now() + 40000 });

test('answerWith: correct reply passes', async () => {
  const call = emiCall();
  const provider = { run: async () => ({ text: 'Aapki EMI ' + call.result.monthly_emi + ' hogi.', calls: [call] }) };
  const out = await answerWith(provider, EMI_MSG, envFor(EMI_MSG));
  assert.equal(out.checked, true);
  assert.ok(!out.fallback);
});

test('answerWith: fabricated number is replaced by calculator fallback', async () => {
  const call = emiCall();
  let runs = 0;
  const provider = { run: async () => { runs++; return { text: 'Aapki EMI ₹99,999 hogi.', calls: [call] }; } };
  const out = await answerWith(provider, EMI_MSG, envFor(EMI_MSG));
  assert.equal(out.fallback, true);
  assert.ok(out.text.includes(call.result.monthly_emi));
  assert.ok(!out.text.includes('99,999'));
  assert.equal(runs, 2); // ek correction retry
});

test('answerWith: forces the tool when model skipped it', async () => {
  const call = emiCall();
  const seen = [];
  const provider = {
    run: async (m, opts) => {
      seen.push(!!opts.force);
      return opts.force
        ? { text: 'EMI ' + call.result.monthly_emi, calls: [call] }
        : { text: 'EMI lagbhag ₹45,000 hogi', calls: [] };
    }
  };
  const out = await answerWith(provider, EMI_MSG, envFor(EMI_MSG));
  assert.deepEqual(seen.slice(0, 2), [false, true]);
  assert.ok(!out.fallback);
});

test('answerWith: unverified rate topic never returns a made-up number', async () => {
  const msgs = [{ role: 'user', content: 'repo rate kya hai' }];
  const env = { ...envFor(msgs), verification: { status: 'unverified' } };
  const provider = { run: async () => ({ text: 'Repo rate 6.5% hai.', calls: [] }) };
  const out = await answerWith(provider, msgs, env);
  assert.equal(out.fallback, true);
  assert.match(out.text, /verify nahi/);
  assert.ok(!/6\.5/.test(out.text));
});

test('answerWith: no retry when time budget is almost over', async () => {
  const call = emiCall();
  let runs = 0;
  const provider = { run: async () => { runs++; return { text: 'EMI ₹99,999', calls: [call] }; } };
  const env = { ...envFor(EMI_MSG), deadline: Date.now() + 3000 };
  const out = await answerWith(provider, EMI_MSG, env);
  assert.equal(runs, 1);
  assert.equal(out.fallback, true);
});

/* ---------- handler ---------- */

test('handler: GET health check and bad method', async () => {
  const g = mockRes();
  await handler({ method: 'GET', headers: {} }, g);
  assert.equal(g.code, 200);
  assert.deepEqual(g.body, { ok: true });
  const d = mockRes();
  await handler({ method: 'DELETE', headers: {} }, d);
  assert.equal(d.code, 405);
});

test('handler: GET with DEBUG_ERRORS=1 shows only key counts, never keys', async t => {
  t.after(reset);
  clearKeys();
  process.env.DEBUG_ERRORS = '1';
  process.env.GEMINI_API_KEY = 'SECRET-GEMINI-ONE';
  process.env.GEMINI_API_KEY_2 = 'SECRET-GEMINI-TWO';
  const g = mockRes();
  await handler({ method: 'GET', headers: {} }, g);
  assert.equal(g.body.keys.gemini.total, 2);
  assert.equal(g.body.keys.groq.total, 0);
  assert.ok(!JSON.stringify(g.body).includes('SECRET'));
});

test('handler: no API keys => simple 503', async t => {
  t.after(reset);
  clearKeys();
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'hi' }]), res);
  assert.equal(res.code, 503);
  assert.ok(res.body.message);
});

test('handler: empty or assistant-last conversation => 400', async t => {
  t.after(reset);
  clearKeys();
  process.env.GROQ_API_KEY = 'x';
  const res = mockRes();
  await handler(req([]), res);
  assert.equal(res.code, 400);
});

test('handler: provider failure returns simple error, no internal details', async t => {
  t.after(reset);
  clearKeys();
  process.env.GROQ_API_KEY = 'x';
  global.fetch = async () => badRes(400, 'SECRET-INTERNAL-DETAIL');
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.equal(res.code, 502);
  assert.ok(!JSON.stringify(res.body).includes('SECRET'));
  assert.equal(res.body.debug, undefined);
});

test('handler: DEBUG_ERRORS=1 exposes provider errors', async t => {
  t.after(reset);
  clearKeys();
  process.env.DEBUG_ERRORS = '1';
  process.env.GROQ_API_KEY = 'x';
  global.fetch = async () => badRes(400, 'detail');
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.ok(Array.isArray(res.body.debug));
});

test('handler: falls back to next provider when the first one fails', async t => {
  t.after(reset);
  clearKeys();
  process.env.GROQ_API_KEY = 'x';
  process.env.GEMINI_API_KEY = 'y';
  global.fetch = async url => (String(url).includes('groq') ? groqText('Namaste ji') : badRes(400, 'gemini down'));
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.reply, 'Namaste ji');
});

test('handler: sirf OpenAI key ho to OpenAI chalta hai (max_completion_tokens, bina temperature)', async t => {
  t.after(reset);
  clearKeys();
  process.env.OPENAI_API_KEY = 'oa-first-key';
  const urls = [];
  global.fetch = async (url, init) => {
    urls.push(String(url));
    assert.match(init.headers.Authorization, /oa-first-key/);
    const body = JSON.parse(init.body);
    assert.ok(body.max_completion_tokens && body.temperature === undefined);
    return groqText('Namaste ji');
  };
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.reply, 'Namaste ji');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /api\.openai\.com/);
});

/* ---------- API key rotation ---------- */

test('handler: Gemini ki pehli key limit par ho to doosri key se jawab aata hai', async t => {
  t.after(reset);
  clearKeys();
  process.env.GEMINI_API_KEY = 'rot-key-one';
  process.env.GEMINI_API_KEY_2 = 'rot-key-two';
  const used = [];
  global.fetch = async (url, init) => {
    const key = init.headers['x-goog-api-key'];
    used.push(key);
    return key === 'rot-key-one' ? badRes(429, 'RESOURCE_EXHAUSTED rate limit') : geminiText('Namaste ji');
  };

  let res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.reply, 'Namaste ji');
  assert.deepEqual(used, ['rot-key-one', 'rot-key-two']);

  // agli request: pehli key cooldown mein hai, seedha doosri key
  used.length = 0;
  res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.equal(res.code, 200);
  assert.deepEqual(used, ['rot-key-two']);
});

test('handler: Gemini ki saari keys limit par => agla provider (OpenRouter) jawab deta hai', async t => {
  t.after(reset);
  clearKeys();
  process.env.GEMINI_API_KEY = 'all-limit-one';
  process.env.GEMINI_API_KEY_2 = 'all-limit-two';
  process.env.OPENROUTER_API_KEY = 'x';
  const seen = [];
  global.fetch = async url => {
    seen.push(String(url));
    return String(url).includes('openrouter') ? groqText('OpenRouter se jawab') : badRes(429, 'rate limit');
  };
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.reply, 'OpenRouter se jawab');
  // Gemini ki dono keys try hui (3.6 flash par), phir OpenRouter
  assert.ok(seen.filter(u => u.includes('generativelanguage')).length >= 2);
});

test('handler: galat (401) key ke baad doosri key chalti hai', async t => {
  t.after(reset);
  clearKeys();
  process.env.GEMINI_API_KEYS = 'bad-key-aaaa,good-key-bbbb';
  global.fetch = async (url, init) =>
    (init.headers['x-goog-api-key'] === 'bad-key-aaaa' ? badRes(401, 'API key not valid') : geminiText('Namaste ji'));
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.reply, 'Namaste ji');
});

test('handler: PDF is never sent to a text-only provider', async t => {
  t.after(reset);
  clearKeys();
  process.env.GROQ_API_KEY = 'x';
  let called = false;
  global.fetch = async () => { called = true; return okRes({}); };
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'ye dekho', attachments: [{ mime: 'application/pdf', data: 'AAAA' }] }]), res);
  assert.equal(res.code, 503);
  assert.equal(called, false);
});

test('handler: oversized request => 413', async () => {
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'x'.repeat(4300000) }]), res);
  assert.equal(res.code, 413);
});

test('handler: rate limited IP gets 429', async t => {
  t.after(reset);
  clearKeys();
  process.env.GROQ_API_KEY = 'x';
  global.fetch = async () => badRes(400);
  const ip = '99.99.99.99';
  let last;
  for (let i = 0; i < 11; i++) {
    last = mockRes();
    await handler({ method: 'POST', headers: { 'x-forwarded-for': ip }, body: { messages: [{ role: 'user', content: 'hi' }] } }, last);
  }
  assert.equal(last.code, 429);
});

/* ---------- regression: bugs jo review mein mile ---------- */

test('answerWith: model galat amount se tool chalaye to authoritative inputs ka result aata hai', async () => {
  const wrongArgs = { principal: 50000, annual_rate: 8.5, years: 20 };
  const wrong = { name: 'calc_emi', args: wrongArgs, result: engine.runTool('calc_emi', wrongArgs) };
  const right = engine.runTool('calc_emi', EMI_ARGS);
  const provider = { run: async () => ({ text: 'EMI ' + wrong.result.monthly_emi + ' hogi.', calls: [wrong] }) };
  const out = await answerWith(provider, EMI_MSG, envFor(EMI_MSG));
  assert.equal(out.fallback, true);
  assert.ok(out.text.includes(right.monthly_emi));
  assert.ok(!out.text.includes(wrong.result.monthly_emi));
});

test('answerWith: model ne rate khud guess kiya to sirf kami poochhi jaati hai', async () => {
  const msgs = [{ role: 'user', content: '50 lakh ka home loan 20 saal EMI' }];
  const args = { principal: 5000000, annual_rate: 9, years: 20 };
  const call = { name: 'calc_emi', args, result: engine.runTool('calc_emi', args) };
  const provider = { run: async () => ({ text: 'EMI ' + call.result.monthly_emi + ' hogi (9% maan kar).', calls: [call] }) };
  const out = await answerWith(provider, msgs, envFor(msgs));
  assert.equal(out.fallback, true);
  assert.match(out.text, /interest rate/);
  assert.ok(!out.text.includes(call.result.monthly_emi));
});

test('answerWith: calc reply mein salah wala % ("income ka 40%") galat flag nahi hota', async () => {
  const call = emiCall();
  const provider = { run: async () => ({
    text: 'EMI ' + call.result.monthly_emi + ' hai. Aam taur par EMI income ke 40% se zyada nahi honi chahiye.',
    calls: [call]
  }) };
  const out = await answerWith(provider, EMI_MSG, envFor(EMI_MSG));
  assert.ok(!out.fallback);
});

test('handler: verified RBI jawab pass hota hai, banaya hua rate fallback hota hai', async t => {
  t.after(reset);
  clearKeys();
  process.env.GEMINI_API_KEY = 'y';

  const grounded = {
    candidates: [{
      content: { parts: [{ text: 'RBI ke mutabik repo rate 5.5% hai (policy update).' }] },
      groundingMetadata: { groundingChunks: [{ web: { uri: 'https://vertexaisearch.example/r/1', title: 'rbi.org.in' } }] }
    }]
  };

  // Gemini ko do kaam: (1) google_search wala lookup, (2) normal chat jawab
  const gemini = chatText => async (url, init) => {
    const body = JSON.parse(init.body);
    const isLookup = Boolean(body.tools && body.tools[0] && body.tools[0].google_search);
    return isLookup ? okRes(grounded) : geminiText(chatText);
  };

  global.fetch = gemini('Repo rate abhi 5.5% hai (rbi.org.in).');
  let res = mockRes();
  await handler(req([{ role: 'user', content: 'RBI repo rate kitna hai verified-test-1?' }]), res);
  assert.equal(res.code, 200);
  assert.match(res.body.reply, /5\.5%/);
  assert.equal(res.body.checked, true);

  global.fetch = gemini('Repo rate abhi 7.25% hai.');
  res = mockRes();
  await handler(req([{ role: 'user', content: 'RBI repo rate kitna hai verified-test-2?' }]), res);
  assert.equal(res.code, 200);
  assert.ok(!/7\.25/.test(res.body.reply));
  assert.match(res.body.reply, /5\.5%/);
});

/* ---------- knowledge base (tayyar jawab) ---------- */

test('handler: "EMI kya hai?" ka tayyar jawab milta hai, API call nahi hoti, key na ho tab bhi', async t => {
  t.after(reset);
  clearKeys();
  let called = false;
  global.fetch = async () => { called = true; return okRes({}); };
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'EMI kya hai?' }]), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.source, 'knowledge');
  assert.equal(res.body.topic, 'emi');
  assert.match(res.body.reply, /Equated Monthly Installment/);
  assert.deepEqual(res.body.options, ['Mere numbers se EMI nikalo']);
  assert.equal(called, false);
});

test('handler: knowledge base wale sawal ke baad "Mere numbers se EMI nikalo" EMI ke inputs poochta hai', async t => {
  t.after(reset);
  clearKeys();
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'Mere numbers se EMI nikalo' }]), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.source, 'router');
  assert.match(res.body.reply, /loan|amount/i);
});

/* ---------- Gmail alerts + secret test link ---------- */

const alerts = require('../lib/alert');
const GMAIL = { GMAIL_USER: 'alerts@gmail.com', GMAIL_APP_PASSWORD: 'abcdefghijklmnop', ALERT_TO: 'owner@gmail.com' };
function fakeMail() {
  const mails = [];
  alerts.__reset();
  alerts.__setNodemailer({ createTransport: () => ({ sendMail: async m => { mails.push(m); } }) });
  Object.assign(process.env, GMAIL);
  return mails;
}
const TOKEN = 'test-admin-token-1234567890';

test('handler: saare AI providers fail => URGENT Gmail alert, user ka text email mein nahi', async t => {
  t.after(reset);
  clearKeys();
  const mails = fakeMail();
  process.env.GROQ_API_KEY = 'x';
  global.fetch = async () => badRes(500, 'boom');
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'mera secret sawal 987654' }]), res);
  assert.notEqual(res.code, 200);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, '[URGENT] Rupeyantra: Saare AI providers fail ho gaye');
  assert.match(mails[0].text, /providers: groq/);
  assert.ok(!mails[0].text.includes('secret sawal'));
  assert.ok(!mails[0].text.includes('987654'));
});

test('handler: koi AI key set na ho => URGENT alert', async t => {
  t.after(reset);
  clearKeys();
  const mails = fakeMail();
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.equal(res.code, 503);
  assert.match(mails[0].subject, /Koi AI API key set nahi hai/);
});

test('handler: galat (401) Gemini key => jawab milta hai aur "key kharab" alert jaata hai', async t => {
  t.after(reset);
  clearKeys();
  const mails = fakeMail();
  process.env.GEMINI_API_KEYS = 'alert-bad-aaaa,alert-good-bbbb';
  global.fetch = async (url, init) =>
    (init.headers['x-goog-api-key'] === 'alert-bad-aaaa' ? badRes(401, 'API key not valid') : geminiText('Namaste ji'));
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.reply, 'Namaste ji');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /^\[URGENT\].*API key kharab/);
  assert.match(mails[0].text, /slot: GEMINI_API_KEY#1/);
  assert.ok(!mails[0].text.includes('alert-bad-aaaa'));
});

test('handler: key ki limit (429) par WARNING alert, jawab phir bhi milta hai', async t => {
  t.after(reset);
  clearKeys();
  const mails = fakeMail();
  process.env.GEMINI_API_KEY = 'warn-key-one-aaaa';
  process.env.GEMINI_API_KEY_2 = 'warn-key-two-bbbb';
  global.fetch = async (url, init) =>
    (init.headers['x-goog-api-key'] === 'warn-key-one-aaaa' ? badRes(429, 'rate limit') : geminiText('Namaste ji'));
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.equal(res.code, 200);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /^\[WARNING\]/);
});

test('handler: secret test link sahi token par email bhejta hai', async t => {
  t.after(reset);
  clearKeys();
  const mails = fakeMail();
  process.env.ADMIN_TOKEN = TOKEN;
  const res = mockRes();
  await handler({ method: 'GET', headers: { 'x-forwarded-for': '10.9.9.1' }, query: { alert_test: TOKEN } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.alert.sent, true);
  assert.equal(res.body.alert.configured, true);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /Test alert/);
  assert.ok(!JSON.stringify(res.body).includes(TOKEN));
  // dobara turant bhi chalta hai (force), par ghante ki limit rehti hai
  const again = mockRes();
  await handler({ method: 'GET', headers: { 'x-forwarded-for': '10.9.9.2' }, query: { alert_test: TOKEN } }, again);
  assert.equal(again.body.alert.sent, true);
});

test('handler: galat/chhota/na-set token par test link kuch nahi karta (normal health jawab)', async t => {
  t.after(reset);
  clearKeys();
  const mails = fakeMail();
  for (const [adminToken, supplied] of [[TOKEN, 'galat-token-1234567890'], [undefined, TOKEN], ['short', 'short']]) {
    if (adminToken === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = adminToken;
    const res = mockRes();
    await handler({ method: 'GET', headers: { 'x-forwarded-for': '10.9.8.' + Math.floor(Math.random() * 200) }, query: { alert_test: supplied } }, res);
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { ok: true });
  }
  assert.equal(mails.length, 0);
});

test('handler: URL se bhi token padha jaata hai (query object na ho tab)', async t => {
  t.after(reset);
  clearKeys();
  const mails = fakeMail();
  process.env.ADMIN_TOKEN = TOKEN;
  const res = mockRes();
  await handler({ method: 'GET', headers: { 'x-forwarded-for': '10.9.7.1' }, url: '/api/chat?alert_test=' + TOKEN }, res);
  assert.equal(res.body.alert.sent, true);
  assert.equal(mails.length, 1);
});

test('handler: token ke aage-peeche space ho to bhi chalta hai (mobile keyboard)', async t => {
  t.after(reset);
  clearKeys();
  const mails = fakeMail();
  process.env.ADMIN_TOKEN = TOKEN + ' ';
  const res = mockRes();
  await handler({ method: 'GET', headers: { 'x-forwarded-for': '10.9.6.1' }, query: { alert_test: ' ' + TOKEN } }, res);
  assert.equal(res.body.alert.sent, true);
  assert.equal(mails.length, 1);
});

test('handler: DEBUG_ERRORS=1 mein test link ki wajah batata hai (token ki value kabhi nahi)', async t => {
  t.after(reset);
  clearKeys();
  fakeMail();
  process.env.DEBUG_ERRORS = '1';
  const note = async (adminToken, supplied) => {
    if (adminToken === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = adminToken;
    const res = mockRes();
    await handler({ method: 'GET', headers: { 'x-forwarded-for': '10.9.5.' + Math.floor(Math.random() * 200) }, query: { alert_test: supplied } }, res);
    assert.ok(!JSON.stringify(res.body).includes(TOKEN));
    return res.body.alert_test;
  };
  assert.match(await note(undefined, TOKEN), /set nahi hai/);
  assert.match(await note('short', 'short'), /16 akshar/);
  assert.match(await note(TOKEN, ''), /khali/);
  assert.match(await note(TOKEN, 'galat-token-1234567890'), /match nahi hua/);
});

/* ---------- roz ki ginti (Upstash) ---------- */

function upstashSetup(providerFetch) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stats-test.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-test-token-123';
  const bodies = [];
  global.fetch = async (url, init) => {
    if (String(url).includes('stats-test.upstash.io')) {
      const cmds = JSON.parse(init.body);
      bodies.push(cmds);
      return okRes(cmds.map(() => ({ result: 1 })));
    }
    return providerFetch(url, init);
  };
  return bodies;
}
const counterNames = bodies => bodies.flat().filter(c => c[0] === 'HINCRBY').map(c => c[2]);

test('handler: tayyar jawab par ginti (kb_hit, intent) likhi jaati hai', async t => {
  t.after(reset);
  clearKeys();
  const bodies = upstashSetup(async () => okRes({}));
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'EMI kya hai?' }]), res);
  assert.equal(res.body.source, 'knowledge');
  const names = counterNames(bodies);
  for (const n of ['requests', 'ok', 'kb_hit', 'intent.emi', 'route.answer_concept']) assert.ok(names.includes(n), n);
});

test('handler: provider ke jawab par ginti, aur user ka text Upstash mein nahi jaata', async t => {
  t.after(reset);
  clearKeys();
  process.env.GEMINI_API_KEY = 'stats-gem-key';
  const bodies = upstashSetup(async () => geminiText('Namaste ji'));
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste mera naam RAMESH-PRIVATE hai' }]), res);
  assert.equal(res.code, 200);
  const names = counterNames(bodies);
  assert.ok(names.includes('provider.gemini.ok'));
  assert.ok(names.includes('requests') && names.includes('ok'));
  const everything = JSON.stringify(bodies);
  assert.ok(!everything.includes('RAMESH-PRIVATE'));
  assert.ok(!everything.includes('Namaste ji'));
  assert.ok(!everything.includes('stats-gem-key'));
});

test('handler: saare provider fail par fail ginti + error ki entry (sirf type/code/provider)', async t => {
  t.after(reset);
  clearKeys();
  process.env.GROQ_API_KEY = 'stats-groq-key';
  const bodies = upstashSetup(async () => badRes(500, 'boom USER-SECRET'));
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'koi sawal USER-SECRET' }]), res);
  assert.notEqual(res.code, 200);
  const names = counterNames(bodies);
  assert.ok(names.includes('fail'));
  assert.ok(names.includes('provider.groq.fail'));
  assert.ok(names.includes('error.server'));
  const push = bodies.flat().find(c => c[0] === 'LPUSH');
  assert.ok(push);
  assert.deepEqual(Object.keys(JSON.parse(push[2])).sort(), ['code', 'provider', 't', 'type']);
  assert.ok(!JSON.stringify(bodies).includes('USER-SECRET'));
});

test('handler: Upstash band/fail ho to chat phir bhi chalta hai', async t => {
  t.after(reset);
  clearKeys();
  process.env.GEMINI_API_KEY = 'stats-gem-key2';
  process.env.UPSTASH_REDIS_REST_URL = 'https://stats-test.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-test-token-123';
  global.fetch = async url => {
    if (String(url).includes('upstash.io')) throw new Error('upstash down');
    return geminiText('Namaste ji');
  };
  const res = mockRes();
  await handler(req([{ role: 'user', content: 'namaste' }]), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.reply, 'Namaste ji');
});
