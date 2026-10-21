'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/providers');

test('detect: key ke prefix se provider pehchana jaata hai', () => {
  assert.equal(P.detect('AIzaSyA1234567890abcdefghijkl'), 'gemini');
  assert.equal(P.detect('gsk_abcdefghijklmnop'), 'groq');
  assert.equal(P.detect('sk-or-v1-abcdef'), 'openrouter');
  assert.equal(P.detect('sk-proj-abcdef'), 'openai');
  assert.equal(P.detect('csk-abcdef'), 'cerebras');
  assert.equal(P.detect('xai-abcdef'), 'xai');
  assert.equal(P.detect('123e4567-e89b-12d3-a456-426614174000'), 'sambanova');
  assert.equal(P.detect('random-text'), null);
});

test('AI_KEYS: auto-detect, naam:key, aur anjaan key ginti mein (key kabhi nahi)', () => {
  const r = P.parseAiKeys({ AI_KEYS: 'AIzaKEY1xxxxxxxx, gsk_k2 deepseek:sk-ds1\nmystery-key' });
  assert.deepEqual(r.keys.map(k => k.provider), ['gemini', 'groq', 'deepseek']);
  assert.equal(r.unknown, 1);
  assert.ok(!JSON.stringify(r).includes('mystery'));
});

test('pool: provider ke apne env + AI_KEYS + koi bhi KEY env, sab ek pool mein (duplicate nahi)', () => {
  const env = { GROQ_API_KEY: 'gsk_one', AI_KEYS: 'gsk_two, gsk_one', MY_RANDOM_KEY: 'gsk_three', UPSTASH_REDIS_REST_TOKEN: 'gsk_notmine', MY_ID: 'gsk_nope' };
  const pools = P.makePools(env);
  assert.equal(pools.groq.size(), 3);
  assert.equal(pools.gemini.size(), 0);
});

test('UUID key sirf SAMBA wale env ya naam:key se', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  assert.equal(P.makePools({ SOME_KEY: uuid }).sambanova.size(), 0);
  assert.equal(P.makePools({ SAMBANOVA_KEY: uuid }).sambanova.size(), 1);
  assert.equal(P.makePools({ AI_KEYS: uuid }).sambanova.size(), 1);
});

test('configured: model/url ke bina OpenAI-compatible provider nahi chalta', () => {
  assert.equal(P.configured('groq', {}), true);
  assert.equal(P.configured('xai', {}), false);
  assert.equal(P.configured('xai', { XAI_MODEL: 'm' }), true);
  assert.equal(P.configured('custom', { CUSTOM_AI_URL: 'https://x.example/v1/chat/completions', CUSTOM_AI_MODEL: 'm' }), true);
  assert.equal(P.configured('custom', { CUSTOM_AI_URL: 'http://insecure', CUSTOM_AI_MODEL: 'm' }), false);
  assert.deepEqual(P.NAMES.slice(0, 4), ['gemini', 'groq', 'openrouter', 'openai']);
});
