'use strict';

/*
 * lib/python-bridge.js tests.
 *  - Offline part: a small fake service plays the engine's part (timeouts, tokens, approved list, "evidence before claiming Python").
 *  - Real part: runs the REAL python-engine through the bridge (local process) and through the REAL secured server.py.
 *    It is skipped when RY_PYTHON is not set (GitHub Actions sets it).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const python = require('../lib/python-bridge');

const REAL = process.env.RY_PYTHON || '';
const ID = 'a'.repeat(32);
const good = fn => ({ engine: 'python', function: fn, executed: true, success: true, execution_id: ID, duration_ms: 1.5, version: '0.1.0', result: { mean: 3 } });

function serve(handler) {
  return new Promise(resolve => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => { seen.push({ url: req.url, auth: req.headers.authorization, body }); handler(req, res, body); });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server, seen, env: { PY_SERVICE_URL: 'http://127.0.0.1:' + server.address().port, PY_SERVICE_TOKEN: 'secret' },
      close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); })
    }));
  });
}
const reply = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

test('approved list in JS equals the registry in engine.py', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'python-engine', 'src', 'engine.py'), 'utf8');
  const names = [...src.matchAll(/^\s{4}"(\w+)": \(/gm)].map(m => m[1]).sort();
  assert.ok(names.length >= 13);
  assert.deepEqual([...python.APPROVED].sort(), names);
});

test('not configured: ENGINE_UNAVAILABLE, nothing thrown, Python may not be claimed', async () => {
  const r = await python.call('forecast', {}, { env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ENGINE_UNAVAILABLE');
  assert.equal(python.isConfigured({}), false);
  assert.equal(python.mayClaimPython(r), false);
  assert.equal(python.aiBrief(r), null);
});

test('config rules: https needed off-machine, token needed for public hosts', () => {
  assert.equal(python.config({ PY_SERVICE_URL: 'http://example.com', PY_SERVICE_TOKEN: 't' }), null);
  assert.equal(python.config({ PY_SERVICE_URL: 'https://example.com' }), null);
  assert.equal(python.config({ PY_SERVICE_URL: 'nonsense', PY_SERVICE_TOKEN: 't' }), null);
  assert.equal(python.config({ PY_SERVICE_URL: 'https://example.com/', PY_SERVICE_TOKEN: 't' }).url, 'https://example.com/run');
  assert.equal(python.config({ PY_SERVICE_URL: 'http://localhost:9' }).mode, 'service');
  assert.equal(python.config({ RY_PYTHON: 'python3' }).mode, 'local');
});

test('only approved functions and plain-object args are sent', async () => {
  const s = await serve((q, res) => reply(res, good('x')));
  try {
    for (const fn of ['run_shell', 'eval', 'exec', '__import__', '', undefined, 5, '__proto__', 'emi', 'monte_carlo']) {
      assert.equal((await python.call(fn, {}, { env: s.env })).code, 'NOT_APPROVED', String(fn));
    }
    assert.equal((await python.call('forecast', [1, 2], { env: s.env })).code, 'INVALID_INPUT');
    assert.equal((await python.call('forecast', null, { env: s.env })).code, 'INVALID_INPUT');
    assert.equal((await python.call('forecast', { x: 'x'.repeat(2000000) }, { env: s.env })).code, 'TOO_LARGE');
    assert.equal(s.seen.length, 0, 'nothing unapproved reached the service');
  } finally { await s.close(); }
});

test('a complete execution record passes; token and body are sent', async () => {
  const s = await serve((q, res, body) => reply(res, good(JSON.parse(body).function)));
  try {
    const r = await python.call('describe_series', { values: [1, 2, 3] }, { env: s.env });
    assert.equal(r.ok, true);
    assert.equal(r.engine, 'python');
    assert.equal(r.execution.execution_id, ID);
    assert.equal(r.execution.version, '0.1.0');
    assert.ok(r.execution.round_trip_ms >= 0);
    assert.deepEqual(r.result, { mean: 3 });
    assert.equal(s.seen[0].url, '/run');
    assert.equal(s.seen[0].auth, 'Bearer secret');
    assert.deepEqual(JSON.parse(s.seen[0].body), { function: 'describe_series', args: { values: [1, 2, 3] } });
    assert.equal(python.mayClaimPython(r), true);
    assert.match(python.aiBrief(r), /VERIFIED PYTHON RESULT/);
    assert.match(python.engineLabel(r), /Python engine v0\.1\.0/);
  } finally { await s.close(); }
});

test('answers without a full execution record are rejected', async () => {
  const f = 'describe_series';
  const bad = [
    { ok: true, result: { mean: 1 } },
    { ...good(f), engine: 'julia' },
    { ...good(f), function: 'forecast' },
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
      const r = await python.call(f, { values: [1, 2, 3] }, { env: s.env });
      assert.equal(r.ok, false, JSON.stringify(b));
      assert.equal(r.code, 'BAD_RESPONSE');
      assert.equal(python.mayClaimPython(r), false);
      assert.equal(python.aiBrief(r), null);
    } finally { await s.close(); }
  }
  assert.equal(python.aiBrief({ ok: true, engine: 'python', result: {} }), null);                 // forged, no record
  assert.equal(python.aiBrief({ ok: true, engine: 'python', result: {}, execution: { execution_id: 'x' } }), null);
});

test('engine failures pass through with known codes only', async () => {
  const f = 'forecast';
  const failure = (code, msg) => ({ ...good(f), success: false, result: undefined, error: { code, message: msg } });
  const s = await serve((q, res) => reply(res, failure('INVALID_INPUT', 'values needs at least 5 values')));
  try {
    const r = await python.call(f, {}, { env: s.env });
    assert.deepEqual([r.ok, r.code], [false, 'INVALID_INPUT']);
    assert.match(r.error, /at least 5/);
  } finally { await s.close(); }
  const s2 = await serve((q, res) => reply(res, failure('WEIRD', 'x'.repeat(1000))));
  try {
    const r = await python.call(f, {}, { env: s2.env });
    assert.equal(r.code, 'INTERNAL_ERROR');
    assert.ok(r.error.length <= 300);
  } finally { await s2.close(); }
});

test('timeout, rejected token, garbage, redirect and dead service all fail safely', async () => {
  const slow = await serve(() => { /* never answers */ });
  try {
    const t0 = Date.now();
    const r = await python.call('forecast', {}, { env: slow.env, timeoutMs: 300 });
    assert.equal(r.code, 'TIMEOUT');
    assert.ok(Date.now() - t0 < 3000);
  } finally { await slow.close(); }

  const denied = await serve((q, res) => reply(res, { ok: false }, 401));
  try { assert.equal((await python.call('forecast', {}, { env: denied.env })).code, 'ENGINE_UNAVAILABLE'); } finally { await denied.close(); }

  const junk = await serve((q, res) => { res.writeHead(200); res.end('<html>oops</html>'); });
  try { assert.equal((await python.call('forecast', {}, { env: junk.env })).code, 'BAD_RESPONSE'); } finally { await junk.close(); }

  const redirect = await serve((q, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); });
  try { assert.equal((await python.call('forecast', {}, { env: redirect.env })).ok, false); } finally { await redirect.close(); }

  const dead = await serve((q, res) => reply(res, {}));
  const env = dead.env;
  await dead.close();
  assert.equal((await python.call('forecast', {}, { env })).code, 'ENGINE_UNAVAILABLE');
});

test('local mode: missing executable is ENGINE_UNAVAILABLE', async () => {
  const r = await python.call('forecast', {}, { env: { RY_PYTHON: '/no/such/python' }, timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ENGINE_UNAVAILABLE');
});

/* ---------------- REAL Python ---------------- */

const SKIP = !REAL && 'RY_PYTHON not set';
const history = Array.from({ length: 60 }, (_, i) => 100 + 2 * i);

test('REAL Python (local process) returns a verified execution record', { skip: SKIP }, async () => {
  const env = { RY_PYTHON: REAL };
  const r = await python.call('describe_series', { values: [1, 2, 3, 4, 5] }, { env, timeoutMs: 30000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(python.mayClaimPython(r), true);
  assert.equal(r.result.summary.mean, 3);
  const r2 = await python.call('describe_series', { values: [1, 2, 3, 4, 5] }, { env, timeoutMs: 30000 });
  assert.notEqual(r.execution.execution_id, r2.execution.execution_id);

  const f = await python.call('forecast', { values: history, horizon: 3, method: 'drift' }, { env, timeoutMs: 30000 });
  assert.equal(f.ok, true);
  assert.deepEqual(f.result.forecast.map(x => Math.round(x.point)), [220, 222, 224]);
  const bad = await python.call('forecast', { values: [1, 2] }, { env, timeoutMs: 30000 });
  assert.equal(bad.code, 'INVALID_INPUT');
});

function freePort() {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

test('REAL secured server.py through the bridge (token, evidence, unavailable when stopped)', { skip: SKIP }, async () => {
  const port = await freePort();
  const token = 'bridge-test-token-0123456789';
  const child = spawn(REAL, [path.join(__dirname, '..', 'python-engine', 'server.py')], {
    env: { ...process.env, PY_SERVICE_TOKEN: token, PY_SERVICE_PORT: String(port), PY_SERVICE_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  const env = { PY_SERVICE_URL: 'http://127.0.0.1:' + port, PY_SERVICE_TOKEN: token };
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(env.PY_SERVICE_URL + '/health')).ok; } catch (e) { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(up, 'service started');
    const ok = await python.call('detect_anomalies', { values: [...Array(40).fill(0).map((_, i) => 100 + (i % 3)), 900, ...Array(10).fill(101)] }, { env });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(python.mayClaimPython(ok), true);
    assert.ok(ok.result.flags.some(f => f.type === 'level_outlier' && f.index === 40));
    const wrong = await python.call('forecast', { values: history }, { env: { ...env, PY_SERVICE_TOKEN: 'wrong-token-0123456789' } });
    assert.equal(wrong.code, 'ENGINE_UNAVAILABLE');
    assert.equal(python.mayClaimPython(wrong), false);
  } finally {
    child.kill('SIGKILL');
  }
  await new Promise(r => setTimeout(r, 200));
  const gone = await python.call('forecast', { values: history }, { env });
  assert.equal(gone.code, 'ENGINE_UNAVAILABLE');
  assert.equal(python.aiBrief(gone), null);
});
