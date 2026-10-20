'use strict';
// Run: npm test   (ya: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAsk, buildUserPrompt, SYSTEM, MAX_QUESTION } = require('../lib/admin-chat');
const { createHandler } = require('../api/admin/chat');

const REPORT = { ok: true, today: { requests: 5 }, keys: { gemini: { total: 1, available: 1 } } };

function mockRes() {
  return {
    code: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const logged = { checkSession: async t => (t === 'good' ? { email: 'a@b.com' } : null) };
const statusFake = { build: async () => REPORT };
const call = (handler, { body = { message: 'aaj kitne sawal?' }, cookie = 'rp_admin=good', method = 'POST', origin } = {}) => {
  const res = mockRes();
  const headers = { host: 'rupyantra-psi.vercel.app', cookie };
  if (origin) headers.origin = origin;
  return handler({ method, headers, body }, res).then(() => res);
};

test('prompt: report data ke roop mein aata hai, system prompt mein keys na batane ka niyam', () => {
  const p = buildUserPrompt('kya chal raha hai', REPORT);
  assert.match(p, /REPORT \(sirf data\)/);
  assert.match(p, /"requests":5/);
  assert.match(SYSTEM, /API keys, tokens ya passwords kabhi mat batao/);
  assert.match(SYSTEM, /khud nahi karte/);
});

test('prompt: bahut lamba report kaat diya jata hai', () => {
  const big = { text: 'x'.repeat(20000) };
  assert.ok(buildUserPrompt('q', big).length < 9000);
});

test('ask: bina keys ke provider error deta hai, koi network call nahi', async () => {
  let called = false;
  const ask = createAsk({ env: {}, fetch: async () => { called = true; return {}; } });
  await assert.rejects(ask('q', REPORT));
  assert.equal(called, false);
});

test('ask: Gemini fail ho to Groq par jaata hai', async () => {
  const seen = [];
  const env = { GEMINI_API_KEY: 'gem-key-test-aaaaaaaa', GROQ_API_KEY: 'groq-key-test-bbbbbbbb' };
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('generativelanguage')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Groq ka jawab' } }] }) };
  };
  const ask = createAsk({ env, fetch: fetchImpl });
  const out = await ask('q', REPORT);
  assert.equal(out, 'Groq ka jawab');
  assert.ok(seen.some(u => u.includes('generativelanguage')));
  assert.ok(seen.some(u => u.includes('groq.com')));
});

test('handler: bina login 401; login ke baad jawab', async () => {
  const ask = async (q, r) => 'Aaj ' + r.today.requests + ' sawal aaye.';
  const handler = createHandler({ auth: logged, status: statusFake, ask });
  assert.equal((await call(handler, { cookie: '' })).code, 401);
  const ok = await call(handler);
  assert.equal(ok.code, 200);
  assert.equal(ok.body.answer, 'Aaj 5 sawal aaye.');
});

test('handler: khaali ya bahut lamba sawal par 400; GET par 405', async () => {
  const handler = createHandler({ auth: logged, status: statusFake, ask: async () => 'x' });
  assert.equal((await call(handler, { body: { message: '   ' } })).code, 400);
  assert.equal((await call(handler, { body: { message: 'a'.repeat(MAX_QUESTION + 1) } })).code, 400);
  assert.equal((await call(handler, { method: 'GET' })).code, 405);
});

test('handler: alag origin par 403; AI na chale to saaf message, koi detail nahi', async () => {
  const handler = createHandler({ auth: logged, status: statusFake, ask: async () => { throw new Error('GEMINI_API_KEY secret-xyz'); } });
  assert.equal((await call(handler, { origin: 'https://evil.example' })).code, 403);
  const res = await call(handler);
  assert.equal(res.code, 503);
  assert.ok(!JSON.stringify(res.body).includes('secret-xyz'));
  assert.ok(!JSON.stringify(res.body).includes('GEMINI'));
});
