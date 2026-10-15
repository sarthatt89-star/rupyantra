'use strict';
// Run: npm test   (ya: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createKeyPool, withKeys, readKeys } = require('../lib/key-pool');

const httpErr = (status, msg = 'x', headers) =>
  Object.assign(new Error('T HTTP ' + status + ': ' + msg), { status, headers });

function setup(env, start = 1000000) {
  const clock = { t: start };
  const pool = createKeyPool('GEMINI_API_KEY', { env, now: () => clock.t });
  return { pool, clock };
}

/* ---------- env se keys ---------- */

test('readKeys: base, numbered aur comma list; trim + duplicate hataye jaate hain', () => {
  const keys = readKeys('GEMINI_API_KEY', {
    GEMINI_API_KEY: ' k1 ',
    GEMINI_API_KEY_1: 'k1',
    GEMINI_API_KEY_2: 'k2',
    GEMINI_API_KEY_10: 'k10',
    GEMINI_API_KEYS: 'k3, k4\nk2;k5'
  });
  assert.deepEqual(keys, ['k1', 'k2', 'k10', 'k3', 'k4', 'k5']);
  assert.deepEqual(readKeys('X', {}), []);
});

test('pool: env badalne par keys turant badalti hain (redeploy ke baad)', () => {
  const env = { GEMINI_API_KEY: 'a' };
  const { pool } = setup(env);
  assert.equal(pool.size(), 1);
  env.GEMINI_API_KEY_2 = 'b';
  assert.equal(pool.size(), 2);
});

/* ---------- rotation ---------- */

test('withKeys: 429 par agli key chalti hai, pehli key cooldown mein jaati hai', async () => {
  const { pool, clock } = setup({ GEMINI_API_KEY: 'k1', GEMINI_API_KEY_2: 'k2' });
  const used = [];
  const fn = async slot => {
    used.push(slot.key);
    if (slot.key === 'k1') throw httpErr(429, 'rate limit', { 'retry-after': '30' });
    return 'ok';
  };

  assert.equal(await withKeys(pool, 'Gemini', fn), 'ok');
  assert.deepEqual(used, ['k1', 'k2']);
  assert.deepEqual(pool.summary(), { total: 2, available: 1, cooling: 1 });

  // agli request seedha k2 se
  used.length = 0;
  await withKeys(pool, 'Gemini', fn);
  assert.deepEqual(used, ['k2']);

  // 30s baad k1 wapas primary
  clock.t += 31000;
  used.length = 0;
  await withKeys(pool, 'Gemini', async slot => { used.push(slot.key); return 'ok'; });
  assert.deepEqual(used, ['k1']);
});

test('withKeys: 400 aur 5xx par key nahi badalti', async () => {
  for (const status of [400, 500, 503]) {
    const { pool } = setup({ GEMINI_API_KEY: 'k1', GEMINI_API_KEY_2: 'k2' });
    const used = [];
    await assert.rejects(withKeys(pool, 'Gemini', async slot => { used.push(slot.key); throw httpErr(status); }));
    assert.deepEqual(used, ['k1'], 'status ' + status);
    assert.equal(pool.summary().cooling, 0);
  }
});

test('withKeys: 401 par key lambe cooldown mein, agli key chalti hai', async () => {
  const { pool, clock } = setup({ GEMINI_API_KEY: 'bad', GEMINI_API_KEY_2: 'good' });
  const fn = async slot => {
    if (slot.key === 'bad') throw httpErr(401, 'API key not valid');
    return slot.key;
  };
  assert.equal(await withKeys(pool, 'Gemini', fn), 'good');
  clock.t += 60 * 60 * 1000; // 1 ghanta baad bhi cooldown mein
  assert.equal(pool.summary().cooling, 1);
  clock.t += 6 * 60 * 60 * 1000;
  assert.equal(pool.summary().cooling, 0);
});

test('withKeys: daily quota wali limit par lamba cooldown', async () => {
  const { pool, clock } = setup({ GEMINI_API_KEY: 'k1', GEMINI_API_KEY_2: 'k2' });
  await withKeys(pool, 'Gemini', async slot => {
    if (slot.key === 'k1') throw httpErr(429, 'You exceeded your current quota');
    return 'ok';
  });
  clock.t += 10 * 60 * 1000;
  assert.equal(pool.summary().cooling, 1);
  clock.t += 21 * 60 * 1000;
  assert.equal(pool.summary().cooling, 0);
});

test('withKeys: saari keys limit par => aakhri error; phir ALL_KEYS_COOLING', async () => {
  const { pool, clock } = setup({ GEMINI_API_KEY: 'k1', GEMINI_API_KEY_2: 'k2' });
  const used = [];
  const fn = async slot => { used.push(slot.key); throw httpErr(429, 'rate limit'); };

  await assert.rejects(withKeys(pool, 'Gemini', fn), /429/);
  assert.deepEqual(used, ['k1', 'k2']);

  used.length = 0;
  await assert.rejects(withKeys(pool, 'Gemini', fn), e => e.code === 'ALL_KEYS_COOLING' && e.retryAfterMs > 0);
  assert.deepEqual(used, []); // koi request bheji hi nahi

  clock.t += 61000;
  await assert.rejects(withKeys(pool, 'Gemini', fn), /429/);
  assert.deepEqual(used, ['k1', 'k2']);
});

test('withKeys: sirf ek key ho to cooldown chhota rehta hai (provider poora band nahi)', async () => {
  const { pool, clock } = setup({ GEMINI_API_KEY: 'only' });
  await assert.rejects(withKeys(pool, 'Gemini', async () => { throw httpErr(429, 'rate limit'); }));
  assert.equal(pool.summary().cooling, 1);
  clock.t += 16000;
  assert.equal(pool.summary().cooling, 0);
});

/* ---------- fast flag, missing keys, privacy ---------- */

test('withKeys: fast=true jab aur keys bachi hon, aakhri key par false', async () => {
  const { pool } = setup({ GEMINI_API_KEY: 'k1', GEMINI_API_KEY_2: 'k2' });
  const flags = [];
  await withKeys(pool, 'Gemini', async slot => {
    flags.push(slot.fast);
    if (slot.key === 'k1') throw httpErr(429, 'rate limit');
    return 'ok';
  });
  assert.deepEqual(flags, [true, false]);
});

test('withKeys: koi key set na ho to "API key missing"', async () => {
  const { pool } = setup({});
  await assert.rejects(withKeys(pool, 'Gemini', async () => 'x'), /API key missing/);
});

test('summary aur label mein asli key kabhi nahi aati', async () => {
  const { pool } = setup({ GEMINI_API_KEY: 'SECRET-KEY-111', GEMINI_API_KEY_2: 'SECRET-KEY-222' });
  assert.ok(!JSON.stringify(pool.summary()).includes('SECRET'));
  const labels = [];
  await withKeys(pool, 'Gemini', async slot => { labels.push(slot.label); return 'ok'; });
  assert.deepEqual(labels, ['GEMINI_API_KEY#1']);
});

/* ---------- onRotate hook (Gmail alert ke liye) ---------- */

test('withKeys: onRotate hook key badalne par bulaya jaata hai; hook fail ho to bhi request chalti hai', async () => {
  const { pool } = setup({ GEMINI_API_KEY: 'k1', GEMINI_API_KEY_2: 'k2' });
  const seen = [];
  const out = await withKeys(pool, 'Gemini', async slot => {
    if (slot.key === 'k1') throw httpErr(401, 'API key not valid');
    return slot.key;
  }, { onRotate: (type, label) => { seen.push([type, label]); } });
  assert.equal(out, 'k2');
  assert.deepEqual(seen, [['auth', 'GEMINI_API_KEY#1']]);

  const { pool: pool2 } = setup({ GEMINI_API_KEY: 'k1', GEMINI_API_KEY_2: 'k2' });
  const out2 = await withKeys(pool2, 'Gemini', async slot => {
    if (slot.key === 'k1') throw httpErr(429, 'rate limit');
    return slot.key;
  }, { onRotate: () => { throw new Error('hook toota'); } });
  assert.equal(out2, 'k2');
});
