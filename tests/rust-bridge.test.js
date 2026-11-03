'use strict';

/*
 * lib/rust-bridge.js tests.
 *  - Offline part: a small fake service plays the engine's part (timeouts, tokens, approved list, "evidence before claiming Rust").
 *  - Real part: runs the REAL rupeyantra-rust binary through the bridge (local process) and through the REAL secured service.
 *    It is skipped when RY_RUST (path to the built binary) is not set; GitHub Actions sets it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const rust = require('../lib/rust-bridge');

const REAL = process.env.RY_RUST || '';
const ID = 'a'.repeat(32);
const good = fn => ({ engine: 'rust', function: fn, executed: true, success: true, execution_id: ID, duration_ms: 1.5, version: '0.1.0', result: { windows_computed: 3 } });

function serve(handler) {
  return new Promise(resolve => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => { seen.push({ url: req.url, auth: req.headers.authorization, body }); handler(req, res, body); });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server, seen, env: { RUST_SERVICE_URL: 'http://127.0.0.1:' + server.address().port, RUST_SERVICE_TOKEN: 'secret' },
      close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); })
    }));
  });
}
const reply = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

test('approved list in JS equals the registry in engine.rs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'rust-engine', 'src', 'engine.rs'), 'utf8');
  const registry = src.slice(src.indexOf('pub const REGISTRY'), src.indexOf('];', src.indexOf('pub const REGISTRY')));
  const names = [...registry.matchAll(/Func \{ name: "(\w+)"/g)].map(m => m[1]).sort();
  assert.ok(names.length >= 3);
  assert.deepEqual([...rust.APPROVED].sort(), names);
});

test('not configured: ENGINE_UNAVAILABLE, nothing thrown, Rust may not be claimed', async () => {
  const r = await rust.call('rolling_stats', {}, { env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ENGINE_UNAVAILABLE');
  assert.equal(rust.isConfigured({}), false);
  assert.equal(rust.mayClaimRust(r), false);
  assert.equal(rust.aiBrief(r), null);
});

test('config rules: https needed off-machine, token needed for public hosts', () => {
  assert.equal(rust.config({ RUST_SERVICE_URL: 'http://example.com', RUST_SERVICE_TOKEN: 't' }), null);
  assert.equal(rust.config({ RUST_SERVICE_URL: 'https://example.com' }), null);
  assert.equal(rust.config({ RUST_SERVICE_URL: 'nonsense', RUST_SERVICE_TOKEN: 't' }), null);
  assert.equal(rust.config({ RUST_SERVICE_URL: 'https://example.com/', RUST_SERVICE_TOKEN: 't' }).url, 'https://example.com/run');
  assert.equal(rust.config({ RUST_SERVICE_URL: 'http://localhost:9' }).mode, 'service');
  assert.equal(rust.config({ RY_RUST: '/x/rupeyantra-rust' }).mode, 'local');
});

test('only approved functions and plain-object args are sent', async () => {
  const s = await serve((q, res) => reply(res, good('x')));
  try {
    for (const fn of ['run_shell', 'eval', 'exec', '__import__', '', undefined, 5, '__proto__', 'forecast', 'emi']) {
      assert.equal((await rust.call(fn, {}, { env: s.env })).code, 'NOT_APPROVED', String(fn));
    }
    assert.equal((await rust.call('rolling_stats', [1, 2], { env: s.env })).code, 'INVALID_INPUT');
    assert.equal((await rust.call('rolling_stats', null, { env: s.env })).code, 'INVALID_INPUT');
    assert.equal((await rust.call('csv_profile', { csv: 'x'.repeat(2000000) }, { env: s.env })).code, 'TOO_LARGE');
    assert.equal(s.seen.length, 0, 'nothing unapproved reached the service');
  } finally { await s.close(); }
});

test('a complete execution record passes; token and body are sent', async () => {
  const s = await serve((q, res, body) => reply(res, good(JSON.parse(body).function)));
  try {
    const r = await rust.call('rolling_stats', { values: [1, 2, 3, 4], window: 2 }, { env: s.env });
    assert.equal(r.ok, true);
    assert.equal(r.engine, 'rust');
    assert.equal(r.execution.execution_id, ID);
    assert.equal(r.execution.version, '0.1.0');
    assert.ok(r.execution.round_trip_ms >= 0);
    assert.deepEqual(r.result, { windows_computed: 3 });
    assert.equal(s.seen[0].url, '/run');
    assert.equal(s.seen[0].auth, 'Bearer secret');
    assert.deepEqual(JSON.parse(s.seen[0].body), { function: 'rolling_stats', args: { values: [1, 2, 3, 4], window: 2 } });
    assert.equal(rust.mayClaimRust(r), true);
    assert.match(rust.aiBrief(r), /VERIFIED RUST RESULT/);
    assert.match(rust.engineLabel(r), /Rust engine v0\.1\.0/);
  } finally { await s.close(); }
});

test('answers without a full execution record, or from another engine, are rejected', async () => {
  const f = 'rolling_stats';
  const bad = [
    { ok: true, result: { x: 1 } },
    { ...good(f), engine: 'python' },
    { ...good(f), function: 'csv_profile' },
    { ...good(f), execution_id: undefined },
    { ...good(f), execution_id: 'abc' },
    { ...good(f), execution_id: 'G'.repeat(32) },
    { ...good(f), duration_ms: -1 },
    { ...good(f), duration_ms: 'fast' },
    { ...good(f), version: undefined },
    { ...good(f), version: 'v?' },
    { ...good(f), executed: undefined },
    { ...good(f), executed: false },
    { ...good(f), result: undefined },
    { ...good(f), result: 5 },
    [1, 2, 3]
  ];
  for (const b of bad) {
    const s = await serve((q, res) => reply(res, b));
    try {
      const r = await rust.call(f, { values: [1, 2, 3], window: 2 }, { env: s.env });
      assert.equal(r.ok, false, JSON.stringify(b));
      assert.equal(r.code, 'BAD_RESPONSE');
      assert.equal(rust.mayClaimRust(r), false);
      assert.equal(rust.aiBrief(r), null);
    } finally { await s.close(); }
  }
  assert.equal(rust.aiBrief({ ok: true, engine: 'rust', result: {} }), null);                      // forged, no record
  assert.equal(rust.aiBrief({ ok: true, engine: 'rust', result: {}, execution: { execution_id: 'x' } }), null);
});

test('engine failures pass through with known codes only', async () => {
  const f = 'rolling_stats';
  const failure = (code, msg) => ({ ...good(f), success: false, result: undefined, error: { code, message: msg } });
  const s = await serve((q, res) => reply(res, failure('INVALID_INPUT', 'values[1] is missing or not a number')));
  try {
    const r = await rust.call(f, {}, { env: s.env });
    assert.deepEqual([r.ok, r.code], [false, 'INVALID_INPUT']);
    assert.match(r.error, /values\[1\]/);
  } finally { await s.close(); }
  const s2 = await serve((q, res) => reply(res, failure('WEIRD', 'x'.repeat(1000))));
  try {
    const r = await rust.call(f, {}, { env: s2.env });
    assert.equal(r.code, 'INTERNAL_ERROR');
    assert.ok(r.error.length <= 300);
  } finally { await s2.close(); }
});

test('timeout, rejected token, garbage, redirect and dead service all fail safely', async () => {
  const slow = await serve(() => { /* never answers */ });
  try {
    const t0 = Date.now();
    const r = await rust.call('rolling_stats', {}, { env: slow.env, timeoutMs: 300 });
    assert.equal(r.code, 'TIMEOUT');
    assert.ok(Date.now() - t0 < 3000);
  } finally { await slow.close(); }

  const denied = await serve((q, res) => reply(res, { ok: false }, 401));
  try { assert.equal((await rust.call('rolling_stats', {}, { env: denied.env })).code, 'ENGINE_UNAVAILABLE'); } finally { await denied.close(); }

  const junk = await serve((q, res) => { res.writeHead(200); res.end('<html>oops</html>'); });
  try { assert.equal((await rust.call('rolling_stats', {}, { env: junk.env })).code, 'BAD_RESPONSE'); } finally { await junk.close(); }

  const redirect = await serve((q, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); });
  try { assert.equal((await rust.call('rolling_stats', {}, { env: redirect.env })).ok, false); } finally { await redirect.close(); }

  const dead = await serve((q, res) => reply(res, {}));
  const env = dead.env;
  await dead.close();
  assert.equal((await rust.call('rolling_stats', {}, { env })).code, 'ENGINE_UNAVAILABLE');
});

test('local mode: missing executable is ENGINE_UNAVAILABLE', async () => {
  const r = await rust.call('rolling_stats', {}, { env: { RY_RUST: '/no/such/binary' }, timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ENGINE_UNAVAILABLE');
});

/* ---------------- REAL Rust ---------------- */

const SKIP = !REAL && 'RY_RUST not set';

test('REAL Rust (local process) returns a verified execution record', { skip: SKIP }, async () => {
  const env = { RY_RUST: REAL };
  const r = await rust.call('rolling_stats', { values: [1, 2, 3, 4, 5], window: 3 }, { env, timeoutMs: 30000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(rust.mayClaimRust(r), true);
  assert.deepEqual(r.result.rolling_mean, [2, 3, 4]);
  const r2 = await rust.call('rolling_stats', { values: [1, 2, 3, 4, 5], window: 3 }, { env, timeoutMs: 30000 });
  assert.notEqual(r.execution.execution_id, r2.execution.execution_id);

  const c = await rust.call('csv_profile', { csv: 'a,b\n1,x\n1,x\n' }, { env, timeoutMs: 30000 });
  assert.equal(c.ok, true);
  assert.equal(c.result.duplicate_rows, 1);
  const b = await rust.call('batch_returns', { datasets: { A: [100, 110, 121], B: [50, 50, 50] } }, { env, timeoutMs: 30000 });
  assert.equal(b.ok, true);
  assert.ok(Math.abs(b.result.results.A.total_return_percent - 21) < 1e-9);
  const bad = await rust.call('rolling_stats', { values: [1, 2], window: 5 }, { env, timeoutMs: 30000 });
  assert.equal(bad.code, 'INVALID_INPUT');
});

function freePort() {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

test('REAL secured Rust service through the bridge (token, evidence, unavailable when stopped)', { skip: SKIP }, async () => {
  const port = await freePort();
  const token = 'bridge-test-token-0123456789';
  const child = spawn(REAL, ['serve'], {
    env: { ...process.env, RUST_SERVICE_TOKEN: token, RUST_SERVICE_PORT: String(port), RUST_SERVICE_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  const env = { RUST_SERVICE_URL: 'http://127.0.0.1:' + port, RUST_SERVICE_TOKEN: token };
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(env.RUST_SERVICE_URL + '/health')).ok; } catch (e) { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(up, 'service started');
    const ok = await rust.call('rolling_stats', { values: [1, 2, 3, 4, 5, 6], window: 2 }, { env });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(rust.mayClaimRust(ok), true);
    assert.equal(ok.result.windows_computed, 5);
    const wrong = await rust.call('rolling_stats', { values: [1, 2, 3], window: 2 }, { env: { ...env, RUST_SERVICE_TOKEN: 'wrong-token-0123456789' } });
    assert.equal(wrong.code, 'ENGINE_UNAVAILABLE');
    assert.equal(rust.mayClaimRust(wrong), false);
  } finally {
    child.kill('SIGKILL');
  }
  await new Promise(r => setTimeout(r, 200));
  const gone = await rust.call('rolling_stats', { values: [1, 2, 3], window: 2 }, { env });
  assert.equal(gone.code, 'ENGINE_UNAVAILABLE');
  assert.equal(rust.aiBrief(gone), null);
});
