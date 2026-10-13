'use strict';
// Run: npm test   (ya: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const eh = require('../lib/error-handler');

const {
  classifyError, friendlyMessage, extractRetryAfterMs, parseRetryAfter, withTimeout, retry,
  createCircuitBreaker, sanitize, guardToolResult, toHttpResponse, wrapHandler, logError, AppError, shouldAlert
} = eh;

const mkErr = (message, props = {}) => Object.assign(new Error(message), props);
const noSleep = () => Promise.resolve();
const FAKE_GROQ = 'gsk_' + 'a1B2c3D4'.repeat(4);
const FAKE_GEMINI = 'AIza' + 'Xy9Zw8Vu7Ts6Rq5Po4'.repeat(2);
const FAKE_OR = 'sk-or-v1-' + 'f0e1d2c3b4a59687'.repeat(2);

/* ---------- detection ---------- */

test('detect: code error (TypeError) => code/critical', () => {
  const i = classifyError(new TypeError('x is not a function'));
  assert.equal(i.type, 'code');
  assert.equal(i.severity, 'critical');
  assert.equal(i.retryable, false);
});

test('detect: provider 400 => api, no retry; 404 => api NOT_FOUND', () => {
  const i = classifyError(new Error('Groq HTTP 400: bad request'));
  assert.equal(i.type, 'api');
  assert.equal(i.retryable, false);
  assert.equal(i.upstreamStatus, 400);
  assert.equal(classifyError(new Error('Gemini HTTP 404: model not found')).code, 'NOT_FOUND');
});

test('detect: calculation and validation messages', () => {
  assert.equal(classifyError(new Error('Amount calculate nahi ho paya.')).type, 'calculation');
  assert.equal(classifyError(new Error('result is NaN')).type, 'calculation');
  assert.equal(classifyError(new Error('division by zero')).type, 'calculation');
  const v = classifyError(new Error('principal missing hai'));
  assert.equal(v.type, 'validation');
  assert.equal(v.severity, 'minor');
  assert.equal(v.status, 400);
  assert.equal(classifyError('kuch ajeeb').type, 'unknown');
});

test('server: 500/502/503/529 retryable; 504 timeout; 501 critical', () => {
  for (const s of [500, 502, 503, 529]) {
    const i = classifyError(new Error('Groq HTTP ' + s + ': x'));
    assert.equal(i.type, 'server', 'status ' + s);
    assert.equal(i.retryable, true);
  }
  const g = classifyError(new Error('Gemini HTTP 504: gateway'));
  assert.equal(g.type, 'timeout');
  const n = classifyError(mkErr('x', { status: 501 }));
  assert.equal(n.type, 'server');
  assert.equal(n.retryable, false);
  assert.equal(n.severity, 'critical');
});

test('network and timeout detection', () => {
  const e1 = Object.assign(new TypeError('fetch failed'), { cause: mkErr('read ECONNRESET', { code: 'ECONNRESET' }) });
  assert.equal(classifyError(e1).type, 'network');
  assert.equal(classifyError(mkErr('getaddrinfo ENOTFOUND api.x.com', { code: 'ENOTFOUND' })).type, 'network');
  assert.equal(classifyError(new Error('socket hang up')).type, 'network');
  assert.equal(classifyError(new TypeError('fetch failed')).type, 'network');

  const te = new Error('The operation was aborted due to timeout');
  te.name = 'TimeoutError';
  assert.equal(classifyError(te).type, 'timeout');
  assert.equal(classifyError(mkErr('x', { code: 'ETIMEDOUT' })).type, 'timeout');
  assert.equal(classifyError(new Error('Groq timeout')).type, 'timeout');
});

test('rate limit: Retry-After formats, scope, hard quota', () => {
  assert.equal(extractRetryAfterMs(mkErr('x', { headers: { 'Retry-After': '12' } })), 12000);
  assert.equal(extractRetryAfterMs(mkErr('x', { headers: new Headers({ 'retry-after': '3' }) })), 3000);
  assert.equal(extractRetryAfterMs(new Error('Please try again in 7.5s.')), 7500);
  assert.equal(extractRetryAfterMs(new Error('{"retryDelay": "23s"}')), 23000);
  assert.equal(extractRetryAfterMs(new Error('rate limit, try again in 6m12.5s')), 372500);
  assert.equal(extractRetryAfterMs(new Error('no hint here')), null);
  assert.equal(parseRetryAfter('abc'), null);

  const p = classifyError(mkErr('Groq HTTP 429: slow down', { headers: { 'retry-after': '5' } }));
  assert.equal(p.type, 'rate_limit');
  assert.equal(p.scope, 'provider');
  assert.equal(p.status, 503);
  assert.equal(p.retryAfterMs, 5000);

  const u = classifyError(new Error('Too many requests'), { scope: 'user' });
  assert.equal(u.status, 429);

  const q = classifyError(new Error('Gemini HTTP 429: You exceeded your current quota, check billing'));
  assert.equal(q.code, 'QUOTA_EXHAUSTED');
  assert.equal(q.retryable, false);
});

test('auth: 401/403/402, invalid key on 400, missing key => critical, no retry', () => {
  assert.equal(classifyError(new Error('OpenRouter HTTP 402: insufficient credits')).code, 'BILLING');
  for (const e of [
    new Error('Groq HTTP 401: Invalid API Key'),
    new Error('Gemini HTTP 403: PERMISSION_DENIED'),
    new Error('Gemini HTTP 400: API key not valid. Please pass a valid API key.'),
    new Error('GEMINI_API_KEY missing'),
    new Error('Groq API key missing'),
    new Error('Missing authorization header')
  ]) {
    const i = classifyError(e);
    assert.equal(i.type, 'auth', e.message);
    assert.equal(i.severity, 'critical');
    assert.equal(i.retryable, false);
  }
});

test('friendly: koi technical shabd ya secret user message mein nahi', () => {
  const errs = [
    new TypeError('Cannot read properties of undefined'), new Error('Groq HTTP 500: ' + FAKE_GROQ),
    new Error('GEMINI_API_KEY missing'),
    Object.assign(new TypeError('fetch failed'), { cause: mkErr('ECONNRESET', { code: 'ECONNRESET' }) }),
    new Error('Groq timeout'), new Error('Groq HTTP 429'), new Error('NaN result')
  ];
  for (const e of errs) {
    const m = friendlyMessage(e);
    assert.ok(m.length > 20);
    assert.ok(!/HTTP|ECONN|TypeError|undefined|stack|API_KEY|gsk_|NaN/i.test(m), m);
  }
  assert.match(friendlyMessage(new Error('x HTTP 429'), { scope: 'user' }), /ruk kar/);
});

test('severity levels', () => {
  const sev = x => classifyError(x).severity;
  assert.equal(sev(new Error('principal missing hai')), 'minor');
  assert.equal(sev(new Error('Groq HTTP 503')), 'warning');
  assert.equal(sev(new Error('Groq HTTP 401')), 'critical');
  assert.equal(shouldAlert('critical'), true);
  assert.equal(shouldAlert('warning'), false);
});

/* ---------- sensitive data ---------- */

test('sanitize: keys, bearer, JWT, card, email, phone, PAN, OTP hata deta hai; amounts safe', () => {
  const dirty = [
    'key=' + FAKE_GROQ, 'x-goog-api-key: ' + FAKE_GEMINI, 'Authorization: Bearer ' + FAKE_OR,
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    'card 4111 1111 1111 1111', 'mail user@example.com', 'phone 9876543210', 'PAN ABCDE1234F', 'otp 482913',
    '{"password":"hunter2-secret"}', 'aadhaar 1234 5678 9012'
  ].join(' | ');
  const clean = sanitize(dirty, { maxLen: 2000 });
  for (const leak of [FAKE_GROQ, FAKE_GEMINI, FAKE_OR, 'eyJhbGci', '4111 1111', 'user@example.com', '9876543210', 'ABCDE1234F', '482913', 'hunter2', '1234 5678 9012']) {
    assert.ok(!clean.includes(leak), 'leak: ' + leak);
  }
  const safe = sanitize('EMI ₹43,391 aur loan ₹50,00,000, amount ₹9876543210, max_tokens: 1200', { maxLen: 2000 });
  assert.match(safe, /₹43,391/);
  assert.match(safe, /₹50,00,000/);
  assert.match(safe, /₹9876543210/);
  assert.match(safe, /max_tokens: 1200/);
});

test('sanitize: environment ke secrets (aur GEMINI_API_KEYS list ki har key) hat jaati hain', () => {
  process.env.RUPEYANTRA_TEST_SECRET_KEY = 'plain-looking-secret-value-123';
  process.env.RUPEYANTRA_TEST_LIST_KEYS = 'first-list-key-aaaa, second-list-key-bbbb';
  try {
    const s = sanitize('boom plain-looking-secret-value-123 first-list-key-aaaa second-list-key-bbbb boom');
    for (const leak of ['plain-looking', 'first-list-key', 'second-list-key']) assert.ok(!s.includes(leak), leak);
  } finally {
    delete process.env.RUPEYANTRA_TEST_SECRET_KEY;
    delete process.env.RUPEYANTRA_TEST_LIST_KEYS;
  }
});

/* ---------- timeout / retry / breaker ---------- */

test('withTimeout rejects slow task, aborts signal, passes fast task', async () => {
  let aborted = false;
  await assert.rejects(
    withTimeout(signal => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }), 25, 'Groq'),
    e => e.type === 'timeout' && classifyError(e).retryable === true
  );
  assert.equal(aborted, true);
  assert.equal(await withTimeout(Promise.resolve(42), 500), 42);
  await assert.rejects(withTimeout(() => { throw new Error('sync boom'); }, 100), /sync boom/);
});

test('retry: temporary error retried then succeeds (no real sleep)', async () => {
  let calls = 0;
  const delays = [];
  const r = await retry(async () => { calls++; if (calls < 3) throw new Error('Groq HTTP 503: busy'); return 'ok'; },
    { retries: 2, sleep: ms => { delays.push(ms); return Promise.resolve(); }, random: () => 0.5 });
  assert.equal(r, 'ok');
  assert.equal(calls, 3);
  assert.equal(delays.length, 2);
});

test('retry: non-retryable (400, 401, validation) fail immediately', async () => {
  for (const msg of ['Groq HTTP 400: bad', 'Groq HTTP 401: nope', 'principal missing hai']) {
    let calls = 0;
    await assert.rejects(retry(async () => { calls++; throw new Error(msg); }, { sleep: noSleep }));
    assert.equal(calls, 1, msg);
  }
});

test('retry: hard cap, deadline and long Retry-After stop retrying', async () => {
  let calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error('Groq HTTP 500'); }, { retries: 50, sleep: noSleep }));
  assert.equal(calls, 4);

  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error('Groq HTTP 500'); }, { retries: 3, sleep: noSleep, deadlineAt: Date.now() + 500 }));
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw mkErr('Groq HTTP 429', { headers: { 'retry-after': '60' } }); }, { sleep: noSleep }));
  assert.equal(calls, 1);
});

test('retry: short Retry-After is honoured', async () => {
  let calls = 0;
  const delays = [];
  await retry(async () => { calls++; if (calls === 1) throw mkErr('x HTTP 429', { headers: { 'retry-after': '2' } }); return 1; },
    { sleep: ms => { delays.push(ms); return Promise.resolve(); } });
  assert.deepEqual(delays, [2000]);
});

test('retry: shouldRetry can veto (used by key rotation)', async () => {
  let calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error('Groq HTTP 429: rate limit'); },
    { sleep: noSleep, shouldRetry: info => info.retryable && info.type !== 'rate_limit' }));
  assert.equal(calls, 1);
});

test('circuit breaker: opens after failures, recovers after cooldown, ignores validation', async () => {
  let clock = 1000;
  const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: () => clock });
  const fail = () => cb.exec('groq', async () => { throw new Error('Groq HTTP 503'); });
  await assert.rejects(fail());
  await assert.rejects(fail());
  assert.equal(cb.isOpen('groq'), true);
  await assert.rejects(fail(), e => e.code === 'CIRCUIT_OPEN' && classifyError(e).retryable === false);
  clock += 150;
  assert.equal(await cb.exec('groq', async () => 'back'), 'back');
  assert.equal(cb.isOpen('groq'), false);
  for (let i = 0; i < 5; i++) await assert.rejects(cb.exec('v', async () => { throw new Error('principal missing hai'); }));
  assert.equal(cb.isOpen('v'), false);
});

/* ---------- calculation guard ---------- */

test('guardToolResult catches bad financial results', () => {
  const emiArgs = { principal: 100000, annual_rate: 9, years: 5 };
  assert.equal(guardToolResult('calc_emi', emiArgs, { monthly_emi: '₹2,076', total_payment: '₹1,24,534' }).ok, true);
  assert.equal(guardToolResult('calc_emi', emiArgs, { monthly_emi: '-₹2,076', total_payment: '₹1,24,534' }).ok, false);
  assert.equal(guardToolResult('calc_emi', { principal: 100000, annual_rate: 9 }, { monthly_emi: '₹1', total_payment: '₹5,000' }).ok, false);
  assert.equal(guardToolResult('calc_sip', { annual_return: 12 }, { total_invested: '₹6,00,000', future_value: '₹1,000' }).ok, false);
  assert.equal(guardToolResult('calc_sip', { annual_return: -5 }, { total_invested: '₹6,00,000', future_value: '₹5,00,000', estimated_gain: '-₹1,00,000' }).ok, true);
  assert.equal(guardToolResult('calc_lumpsum', { principal: 1000, annual_rate: 8 }, { maturity_amount: '₹900' }).ok, false);
  assert.equal(guardToolResult('calc_gst', { gst_rate: 18 }, { base_amount: '₹100', total_amount: '₹50' }).ok, false);
  assert.equal(guardToolResult('calc_cagr', {}, { cagr_percent: NaN }).ok, false);
  assert.equal(guardToolResult('calc_emi', {}, null).ok, false);
  const v = guardToolResult('calc_emi', {}, { error: 'principal missing hai' });
  assert.equal(v.ok, false);
  assert.equal(v.error.type, 'validation');
  assert.equal(guardToolResult('calc_emi', {}, { error: 'Amount calculate nahi ho paya.' }).error.type, 'calculation');
});

/* ---------- reports, HTTP, wrapper ---------- */

test('logError: structure, request id, only whitelisted fields, no secrets, never throws', () => {
  const lines = [];
  const logger = { info: x => lines.push(['info', x]), warn: x => lines.push(['warn', x]), error: x => lines.push(['error', x]) };
  const r = logError(new Error('Groq HTTP 500: token=' + FAKE_GROQ), {
    requestId: 'req_abc123def', where: 'chat', provider: 'GEMINI_API_KEY#2', attempt: 2, durationMs: 1234,
    userMessage: 'meri income 50000 hai', body: { secret: 'x' }
  }, { logger });
  assert.equal(r.id, 'req_abc123def');
  assert.equal(r.type, 'server');
  assert.equal(r.provider, 'GEMINI_API_KEY#2');
  assert.ok(!JSON.stringify(r).includes(FAKE_GROQ));
  assert.ok(!JSON.stringify(r).includes('income'));
  assert.ok(!('userMessage' in r));
  assert.equal(lines[0][0], 'warn');
  assert.match(eh.createRequestId(), /^req_[0-9a-f]{12}$/);
  assert.equal(eh.requestIdFrom({ headers: { 'x-request-id': 'bad id!' } }).startsWith('req_'), true);

  assert.doesNotThrow(() => logError(undefined, {}, { logger: { warn() { throw new Error('logger down'); } } }));
  assert.doesNotThrow(() => logError(null, {}, { logger: {} }));
});

test('http: status mapping, Retry-After header, zero leakage of internals', () => {
  const secretErr = new Error('Groq HTTP 500: Authorization: Bearer ' + FAKE_OR + ' stack at /var/task/api/chat.js');
  const r = toHttpResponse(secretErr, { requestId: 'req_leak0001' });
  const s = JSON.stringify(r.body);
  assert.equal(r.status, 503);
  assert.ok(!s.includes(FAKE_OR) && !s.includes('/var/task') && !s.includes('Groq'));
  assert.deepEqual(Object.keys(r.body).sort(), ['message', 'requestId', 'retryable']);

  const rl = toHttpResponse(mkErr('slow HTTP 429', { headers: { 'retry-after': '7' } }));
  assert.equal(rl.status, 503);
  assert.equal(rl.headers['Retry-After'], '7');

  const user = toHttpResponse(new Error('too many requests'), { scope: 'user' });
  assert.equal(user.status, 429);
  assert.ok(user.headers['Retry-After']);

  assert.equal(toHttpResponse(new Error('GEMINI_API_KEY missing')).status, 503);
  assert.equal(toHttpResponse(new Error('Groq HTTP 504')).status, 504);
  assert.equal(toHttpResponse(new Error('Groq HTTP 413: too big')).status, 413);

  const dbg = toHttpResponse(new Error('token=' + FAKE_GROQ), { debug: true });
  assert.ok(dbg.body.debug && !JSON.stringify(dbg.body).includes(FAKE_GROQ));

  const all = toHttpResponse(new AppError({ type: 'rate_limit', scope: 'provider', code: 'ALL_KEYS_COOLING', retryAfterMs: 20000, message: 'cooling' }));
  assert.equal(all.status, 503);
  assert.equal(all.body.retryAfterSeconds, 20);
});

test('wrapHandler: throw => sanitized JSON + request id; no double send', async () => {
  const res = {
    headers: {}, headersSent: false, code: null, body: null,
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; }
  };
  const logs = [];
  const h = wrapHandler(async () => { throw new TypeError('secret ' + FAKE_GROQ); }, { logger: { error: x => logs.push(x) } });
  await h({ headers: {} }, res);
  assert.equal(res.code, 500);
  assert.ok(res.body.requestId.startsWith('req_'));
  assert.equal(res.headers['X-Request-Id'], res.body.requestId);
  assert.ok(!JSON.stringify(res.body).includes(FAKE_GROQ));
  assert.ok(!logs.join('').includes(FAKE_GROQ));

  const sent = { headersSent: true, setHeader() {}, status() { throw new Error('should not send'); } };
  await assert.doesNotReject(wrapHandler(async () => { throw new Error('late'); }, { logger: {} })({ headers: {} }, sent));
  assert.equal(await wrapHandler(async () => 'fine')({ headers: {} }, { setHeader() {} }), 'fine');
});

test('flow: API failure => retry => friendly error (no fake numbers)', async () => {
  let calls = 0;
  try {
    await retry(() => withTimeout(async () => { calls++; throw mkErr('Groq HTTP 502: bad gateway'); }, 100, 'Groq'), { retries: 1, sleep: noSleep });
    assert.fail('should fail');
  } catch (e) {
    assert.equal(calls, 2);
    assert.ok(!/\d/.test(friendlyMessage(e)));
  }
});
