'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/provider-router');

const L = (...names) => names.map(name => ({ name }));
const names = r => r.list.map(p => p.name);

test('category: media, facts, calc, long, chat', () => {
  assert.equal(R.categoryOf({ hasMedia: true }), 'media');
  assert.equal(R.categoryOf({ route: { action: 'verify_lookup' } }), 'facts');
  assert.equal(R.categoryOf({ route: { action: 'run_tool' } }), 'calc');
  assert.equal(R.categoryOf({ route: { mode: 'multi' } }), 'calc');
  assert.equal(R.categoryOf({ route: { mode: 'general' }, text: 'x'.repeat(3000) }), 'long');
  assert.equal(R.categoryOf({ route: { mode: 'general' }, text: 'ye [FILE: a.txt] data' }), 'long');
  assert.equal(R.categoryOf({ route: { mode: 'general' }, text: 'namaste' }), 'chat');
  assert.equal(R.categoryOf({}), 'chat');
});

test('order: chat par Groq pehle, calc par Gemini pehle', () => {
  const all = L('gemini', 'groq', 'cerebras', 'openai');
  assert.deepEqual(names(R.order(all, { route: { mode: 'general' }, text: 'hi' })), ['groq', 'cerebras', 'gemini', 'openai']);
  assert.deepEqual(names(R.order(all, { route: { action: 'run_tool' } })), ['gemini', 'groq', 'openai', 'cerebras']);
});

test('order: jiski saari keys cooldown mein hon wo peeche jaata hai', () => {
  const pools = { groq: { summary: () => ({ total: 1, available: 0, cooling: 1 }) }, gemini: { summary: () => ({ total: 1, available: 1, cooling: 0 }) } };
  const r = R.order(L('groq', 'gemini'), { route: { mode: 'general' }, text: 'hi', pools });
  assert.deepEqual(names(r), ['gemini', 'groq']);
});

test('AI_ROUTING env: diye hue naam pehle, galat naam/type ignore', () => {
  const env = { AI_ROUTING: 'chat=openai,gemini; kuchbhi=groq; calc=nahihai' };
  const r = R.order(L('groq', 'gemini', 'openai'), { route: { mode: 'general' }, text: 'hi', env });
  assert.deepEqual(names(r), ['openai', 'gemini', 'groq']);
  assert.equal(R.describe(env).override, true);
  assert.deepEqual(R.describe({}).profiles.media.slice(0, 3), ['gemini', 'openai', 'openrouter']);
});

test('order: junk input par crash nahi', () => {
  assert.deepEqual(R.order(null).list, []);
  assert.doesNotThrow(() => R.order(L('groq'), { pools: { groq: { summary() { throw new Error('x'); } } } }));
});
