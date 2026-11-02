'use strict';

/*
 * lib/julia-bridge.js tests. These need NO Julia: a small fake service plays Julia's part, so timeouts, tokens,
 * the approved-function list and the "evidence before claiming Julia" rule are all checked offline.
 * (The real Julia answers are tested in julia-engine/test and tests/julia-vs-cpp.test.js.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const julia = require('../lib/julia-bridge');

const good = fn => ({ ok: true, engine: 'julia', julia_version: '1.10.12', fn, threads: 4, elapsed_ms: 3.5, result: { p50: 123 } });

function serve(handler) {
  return new Promise(resolve => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body });
        handler(req, res, body);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server, seen, env: { JULIA_SERVICE_URL: 'http://127.0.0.1:' + server.address().port, JULIA_SERVICE_TOKEN: 'secret' },
      close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); })
    }));
  });
}
const reply = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

test('approved list in JS equals the approved list in Julia (api.jl)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'julia-engine', 'src', 'api.jl'), 'utf8');
  const names = [...src.matchAll(/^\s{4}"(\w+)" => \(/gm)].map(m => m[1]).sort();
  assert.ok(names.length >= 14);
  assert.deepEqual([...julia.APPROVED].sort(), names);
});

test('not configured: ENGINE_UNAVAILABLE, nothing thrown', async () => {
  const r = await julia.call('sip_monte_carlo', {}, { env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ENGINE_UNAVAILABLE');
  assert.equal(julia.isConfigured({}), false);
});

test('config rules: https needed off-machine, token needed for public hosts', () => {
  assert.equal(julia.config({ JULIA_SERVICE_URL: 'http://example.com', JULIA_SERVICE_TOKEN: 't' }), null);
  assert.equal(julia.config({ JULIA_SERVICE_URL: 'https://example.com' }), null);
  assert.equal(julia.config({ JULIA_SERVICE_URL: 'not a url', JULIA_SERVICE_TOKEN: 't' }), null);
  assert.equal(julia.config({ JULIA_SERVICE_URL: 'https://example.com/', JULIA_SERVICE_TOKEN: 't' }).url, 'https://example.com/run');
  assert.equal(julia.config({ JULIA_SERVICE_URL: 'http://localhost:9' }).mode, 'service');
  assert.equal(julia.config({ RY_JULIA: 'julia' }).mode, 'local');
});

test('only approved functions and plain-object args are sent', async () => {
  const s = await serve((q, res) => reply(res, good('x')));
  try {
    for (const fn of ['run_shell', 'include', 'eval', '', undefined, 5, '__proto__']) {
      const r = await julia.call(fn, {}, { env: s.env });
      assert.equal(r.code, 'NOT_APPROVED', String(fn));
    }
    assert.equal((await julia.call('goal_plan', [1, 2], { env: s.env })).code, 'INVALID_INPUT');
    assert.equal((await julia.call('goal_plan', null, { env: s.env })).code, 'INVALID_INPUT');
    assert.equal((await julia.call('goal_plan', { x: 'x'.repeat(250000) }, { env: s.env })).code, 'TOO_LARGE');
    assert.equal(s.seen.length, 0, 'nothing unapproved reached the service');
  } finally { await s.close(); }
});

test('a complete Julia answer passes with evidence, token and body are sent', async () => {
  const s = await serve((q, res, body) => reply(res, good(JSON.parse(body).fn)));
  try {
    const r = await julia.call('sip_monte_carlo', { months: 12 }, { env: s.env });
    assert.equal(r.ok, true);
    assert.equal(r.engine, 'julia');
    assert.equal(r.evidence.julia_version, '1.10.12');
    assert.equal(r.evidence.elapsed_ms, 3.5);
    assert.ok(r.evidence.round_trip_ms >= 0);
    assert.deepEqual(r.result, { p50: 123 });
    assert.equal(s.seen[0].url, '/run');
    assert.equal(s.seen[0].auth, 'Bearer secret');
    assert.deepEqual(JSON.parse(s.seen[0].body), { fn: 'sip_monte_carlo', args: { months: 12 } });
    assert.equal(julia.mayClaimJulia(r), true);
    assert.match(julia.aiBrief(r), /VERIFIED JULIA RESULT/);
    assert.match(julia.engineLabel(r), /Julia engine v1\.10\.12/);
  } finally { await s.close(); }
});

test('answers without full Julia evidence are rejected (the AI may not say "Julia")', async () => {
  const bad = [
    { ok: true, result: { p50: 1 } },                                              // no engine
    { ...good('sip_monte_carlo'), engine: 'python' },                              // wrong engine
    { ...good('sip_monte_carlo'), julia_version: undefined },                      // no version
    { ...good('sip_monte_carlo'), julia_version: 'banana' },
    { ...good('sip_monte_carlo'), fn: 'goal_plan' },                               // answer for a different function
    { ...good('sip_monte_carlo'), elapsed_ms: -1 },
    { ...good('sip_monte_carlo'), result: undefined },
    { ...good('sip_monte_carlo'), result: 5 },
    [1, 2, 3]
  ];
  for (const b of bad) {
    const s = await serve((q, res) => reply(res, b));
    try {
      const r = await julia.call('sip_monte_carlo', {}, { env: s.env });
      assert.equal(r.ok, false, JSON.stringify(b));
      assert.equal(r.code, 'BAD_RESPONSE');
      assert.equal(julia.mayClaimJulia(r), false);
      assert.equal(julia.aiBrief(r), null);
    } finally { await s.close(); }
  }
  assert.equal(julia.aiBrief(null), null);
  assert.equal(julia.aiBrief({ ok: true, engine: 'julia', result: {} }), null);      // forged object without evidence
  assert.match(julia.engineLabel({ ok: false }), /istemaal nahi hua/);
});

test('Julia errors pass through with known codes only', async () => {
  const s = await serve((q, res) => reply(res, { ok: false, engine: 'julia', code: 'INVALID_INPUT', error: 'months must be between 1 and 1200' }));
  try {
    const r = await julia.call('sip_monte_carlo', {}, { env: s.env });
    assert.deepEqual([r.ok, r.code], [false, 'INVALID_INPUT']);
  } finally { await s.close(); }
  const s2 = await serve((q, res) => reply(res, { ok: false, engine: 'julia', code: 'WEIRD', error: 'x'.repeat(1000) }));
  try {
    const r = await julia.call('sip_monte_carlo', {}, { env: s2.env });
    assert.equal(r.code, 'INTERNAL_ERROR');
    assert.ok(r.error.length <= 300);
  } finally { await s2.close(); }
});

test('timeout, rejected token, garbage and dead service all fail safely', async () => {
  const slow = await serve(() => { /* never answers */ });
  try {
    const t0 = Date.now();
    const r = await julia.call('sip_monte_carlo', {}, { env: slow.env, timeoutMs: 300 });
    assert.equal(r.code, 'TIMEOUT');
    assert.ok(Date.now() - t0 < 3000);
  } finally { await slow.close(); }

  const denied = await serve((q, res) => reply(res, { error: 'no' }, 401));
  try { assert.equal((await julia.call('sip_monte_carlo', {}, { env: denied.env })).code, 'ENGINE_UNAVAILABLE'); } finally { await denied.close(); }

  const junk = await serve((q, res) => { res.writeHead(200); res.end('<html>oops</html>'); });
  try { assert.equal((await julia.call('sip_monte_carlo', {}, { env: junk.env })).code, 'BAD_RESPONSE'); } finally { await junk.close(); }

  const redirect = await serve((q, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); });
  try { assert.equal((await julia.call('sip_monte_carlo', {}, { env: redirect.env })).ok, false); } finally { await redirect.close(); }

  const dead = await serve((q, res) => reply(res, {}));
  const env = dead.env;
  await dead.close();
  assert.equal((await julia.call('sip_monte_carlo', {}, { env })).code, 'ENGINE_UNAVAILABLE');
});

test('local mode: missing executable is ENGINE_UNAVAILABLE', async () => {
  const r = await julia.call('sip_monte_carlo', {}, { env: { RY_JULIA: '/no/such/julia' }, timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ENGINE_UNAVAILABLE');
});

// Real Julia through the bridge (GitHub Actions sets RY_JULIA=julia; skipped elsewhere).
test('REAL Julia through the bridge returns verified evidence', { skip: !process.env.RY_JULIA && 'RY_JULIA not set' }, async () => {
  const r = await julia.call('sip_monte_carlo', { monthly_amount: 10000, annual_return: 12, annual_volatility: 0, months: 120, simulations: 100 }, { timeoutMs: 120000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(julia.mayClaimJulia(r), true);
  assert.ok(Math.abs(r.result.p50 - 2323390.763519404) < 1e-3);
  const m = await julia.call('matrix_operations', { operation: 'determinant', a: [[4, 3], [6, 3]] }, { timeoutMs: 120000 });
  assert.equal(m.ok, true);
  assert.ok(Math.abs(m.result.result + 6) < 1e-9);
  const bad = await julia.call('goal_plan', { goal_amount: -5, years: 10, annual_return: 10 }, { timeoutMs: 120000 });
  assert.equal(bad.code, 'INVALID_INPUT');
});
