'use strict';
// Run: npm test   (ya: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatus } = require('../lib/admin-status');
const { createHandler } = require('../api/admin/status');

const SECRET_KEY = 'SECRET-GEMINI-KEY-123456';

function fakeStats(overrides = {}) {
  return Object.assign({
    isConfigured: () => true,
    today: () => '2026-10-19',
    readDay: async () => ({ counters: { requests: 5, ok: 4, fail: 1 }, available: true }),
    readRecentErrors: async () => [
      { t: '2026-10-19T05:00:00.000Z', type: 'server', code: 'HTTP_500', provider: 'groq' },
    ],
  }, overrides);
}

function okFetch(failPath) {
  return async url => {
    if (failPath && url.endsWith(failPath)) return { status: 500 };
    return { status: 200 };
  };
}

function statusFor(opts = {}) {
  return createStatus({
    env: { SITE_URL: 'https://site.example/', GEMINI_API_KEY: SECRET_KEY, ...(opts.env || {}) },
    fetch: opts.fetch || okFetch(),
    stats: opts.stats || fakeStats(),
    alertsConfigured: () => true,
    now: () => Date.parse('2026-10-19T10:00:00Z'),
  });
}

test('status: site, calculator, keys, aaj ki ginti sab report mein', async () => {
  const r = await statusFor().build();
  assert.equal(r.site.home.ok, true);
  assert.equal(r.site.ai.ok, true);
  assert.equal(r.site.chatApi.ok, true);
  assert.equal(r.calculator.emi.ok, true);
  assert.equal(r.calculator.sip.ok, true);
  assert.equal(r.keys.gemini.total, 1);
  assert.equal(r.alerts.configured, true);
  assert.equal(r.store.configured, true);
  assert.equal(r.today.requests, 5);
  assert.equal(r.today.fail, 1);
  assert.equal(r.ok, true);
});

test('status: koi key, secret ya env value report mein nahi jaati', async () => {
  const r = await statusFor().build();
  assert.ok(!JSON.stringify(r).includes(SECRET_KEY));
  assert.ok(!JSON.stringify(r).includes('GEMINI_API_KEY'));
});

test('status: ek page fail ho to overall ok false, aur baaki report chalti rahti hai', async () => {
  const r = await statusFor({ fetch: okFetch('/api/chat') }).build();
  assert.equal(r.site.chatApi.ok, false);
  assert.equal(r.site.home.ok, true);
  assert.equal(r.ok, false);
});

test('status: fetch throw kare to crash nahi, network_error record', async () => {
  const r = await statusFor({ fetch: async () => { throw new Error('boom'); } }).build();
  assert.equal(r.site.home.ok, false);
  assert.equal(r.site.home.error, 'network_error');
  assert.equal(r.calculator.emi.ok, true);
});

test('status: SITE_URL na ho to site check nahi, saaf note', async () => {
  const r = await statusFor({ env: { SITE_URL: '' } }).build();
  assert.equal(r.site.config.ok, false);
  assert.match(r.site.config.note, /SITE_URL/);
  assert.equal(r.ok, false);
});

test('status: Upstash na ho to aaj ki ginti "available: false", crash nahi', async () => {
  const r = await statusFor({ stats: fakeStats({ isConfigured: () => false }) }).build();
  assert.equal(r.store.configured, false);
  assert.equal(r.today.available, false);
  assert.deepEqual(r.recentErrors, []);
});

test('status: recent errors mein sirf type/code/provider/time; user ka text kabhi nahi', async () => {
  const stats = fakeStats({
    readRecentErrors: async () => [{
      t: '2026-10-19T05:00:00.000Z', type: 'server', code: 'HTTP_500', provider: 'groq',
      message: 'USER-PRIVATE-TEXT', body: 'USER-PRIVATE-BODY',
    }],
  });
  const r = await statusFor({ stats }).build();
  assert.deepEqual(Object.keys(r.recentErrors[0]).sort(), ['code', 'provider', 't', 'type']);
  assert.ok(!JSON.stringify(r).includes('USER-PRIVATE'));
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

test('handler: bina login 401, login ke baad report, POST par 405', async () => {
  const auth = { checkSession: async t => (t === 'good' ? { email: 'a@b.com' } : null) };
  const handler = createHandler({ auth, status: statusFor() });

  const noCookie = mockRes();
  await handler({ method: 'GET', headers: {} }, noCookie);
  assert.equal(noCookie.code, 401);

  const ok = mockRes();
  await handler({ method: 'GET', headers: { cookie: 'rp_admin=good' } }, ok);
  assert.equal(ok.code, 200);
  assert.equal(ok.body.calculator.emi.ok, true);
  assert.equal(ok.headers['Cache-Control'], 'no-store');

  const post = mockRes();
  await handler({ method: 'POST', headers: { cookie: 'rp_admin=good' } }, post);
  assert.equal(post.code, 405);
});
