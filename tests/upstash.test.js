'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRedis } = require('../lib/upstash');

const ENV = { UPSTASH_REDIS_REST_URL: 'https://example-123.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'tok-secret-abcdef' };
const okRes = body => ({ ok: true, status: 200, json: async () => body });

test('upstash: env na ho to configured=false aur network call nahi', async () => {
  let called = false;
  const r = createRedis({ env: {}, fetch: async () => { called = true; return okRes([]); } });
  assert.equal(r.isConfigured(), false);
  assert.equal(await r.pipeline([['PING']]), null);
  assert.equal(called, false);
});

test('upstash: /pipeline par Bearer token ke saath sahi body jaati hai, natije wapas aate hain', async () => {
  let seen;
  const r = createRedis({ env: ENV, fetch: async (url, init) => { seen = { url, init }; return okRes([{ result: 5 }, { result: 'OK' }]); } });
  const out = await r.pipeline([['HINCRBY', 'k', 'f', 1], ['EXPIRE', 'k', 100]]);
  assert.deepEqual(out, [5, 'OK']);
  assert.equal(seen.url, 'https://example-123.upstash.io/pipeline');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok-secret-abcdef');
  assert.deepEqual(JSON.parse(seen.init.body), [['HINCRBY', 'k', 'f', '1'], ['EXPIRE', 'k', '100']]);
});

test('upstash: quotes aur aakhri slash wali value bhi chalti hai', async () => {
  let url;
  const r = createRedis({
    env: { UPSTASH_REDIS_REST_URL: ' "https://x.upstash.io/" ', UPSTASH_REDIS_REST_TOKEN: '"abc"' },
    fetch: async u => { url = u; return okRes([{ result: 1 }]); }
  });
  assert.equal(r.isConfigured(), true);
  assert.equal(await r.cmd('GET', 'a'), 1);
  assert.equal(url, 'https://x.upstash.io/pipeline');
});

test('upstash: fail, slow, kharab jawab par null; kabhi throw nahi; token kahin nahi', async () => {
  for (const f of [
    async () => { throw new Error('network down tok-secret-abcdef'); },
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => okRes({ not: 'array' }),
    async () => okRes([{ error: 'ERR bad' }])
  ]) {
    const r = createRedis({ env: ENV, fetch: f });
    const out = await r.pipeline([['GET', 'a']]);
    assert.ok(out === null || out[0] === null);
  }
  const slow = createRedis({ env: ENV, fetch: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
  const t = Date.now();
  assert.equal(await slow.pipeline([['GET', 'a']], { timeoutMs: 50 }), null);
  assert.ok(Date.now() - t < 1500);
});

test('upstash: https ke bina URL ya khali command list par kuch nahi', async () => {
  const r = createRedis({ env: { UPSTASH_REDIS_REST_URL: 'http://insecure', UPSTASH_REDIS_REST_TOKEN: 't' }, fetch: async () => okRes([]) });
  assert.equal(r.isConfigured(), false);
  assert.equal(await createRedis({ env: ENV, fetch: async () => okRes([]) }).pipeline([]), null);
});
