'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mc = require('../lib/mail-commands');

function fakeStats({ configured = true, today = {}, yesterday = {}, errors = [] } = {}) {
  return {
    isConfigured: () => configured,
    today: () => '2026-10-17',
    yesterday: () => '2026-10-16',
    readDay: async d => ({ counters: d === '2026-10-17' ? today : yesterday, available: configured }),
    readRecentErrors: async () => errors
  };
}
const POOLS = { gemini: { total: 1, available: 1, cooling: 0 }, groq: { total: 1, available: 0, cooling: 1 }, openrouter: { total: 1, available: 1, cooling: 0 }, openai: { total: 0, available: 0, cooling: 0 } };
const TODAY = {
  requests: 10, ok: 9, fail: 1, kb_hit: 2, engine_only: 1, fallback: 1,
  'provider.gemini.ok': 6, 'provider.groq.ok': 1, 'provider.groq.fail': 1,
  'rotate.auth': 1, 'rotate.auth.gemini': 1, 'rotate.rate_limit': 2, 'rotate.rate_limit.groq': 2,
  'intent.emi': 4, 'intent.sip': 2, 'intent.general': 9, 'error.server': 1
};
const run = (cmd, over) => mc.run(cmd, { stats: fakeStats({ today: TODAY, errors: [{ t: '2026-10-17T05:00:00.000Z', type: 'server', code: 'HTTP_500', provider: 'groq' }], ...over }), pools: POOLS, alertsConfigured: true });

test('mail-commands: normalize', () => {
  assert.equal(mc.normalize('STATUS'), 'status');
  assert.equal(mc.normalize(' today '), 'aaj');
  assert.equal(mc.normalize('error'), 'errors');
  assert.equal(mc.normalize('delete-everything'), null);
  assert.equal(mc.normalize(''), null);
});

test('mail-commands: help mein saare commands', async () => {
  const r = await run('help');
  for (const c of ['status', 'keys', 'aaj', 'errors', 'summary']) assert.match(r.reply, new RegExp(c));
});

test('mail-commands: status', async () => {
  const r = await run('status');
  assert.match(r.reply, /chal raha hai/);
  assert.match(r.reply, /gemini 1, groq 1, openrouter 1, openai 0/);
  assert.match(r.reply, /Gmail alert: chalu/);
  assert.match(r.reply, /Aaj: 10 sawal, 1 fail/);
});

test('mail-commands: keys mein cooling aur aaj ki badli', async () => {
  const r = await run('keys');
  assert.match(r.reply, /groq: 1 key \(1 abhi limit par\)/);
  assert.match(r.reply, /auth\.gemini 1/);
  assert.match(r.reply, /rate_limit\.groq 2/);
});

test('mail-commands: aaj, errors, summary', async () => {
  const a = await run('aaj');
  assert.match(a.reply, /Sawal: 10 \| Jawab mila: 9 \| Fail: 1/);
  assert.match(a.reply, /gemini 6 theek \/ 0 fail/);
  assert.match(a.reply, /Topics: emi 4, sip 2/);
  assert.ok(!/intent\.general|general/.test(a.reply));
  const e = await run('errors');
  assert.match(e.reply, /server 1/);
  assert.match(e.reply, /HTTP_500 \| groq/);
  const s = await run('summary');
  assert.match(s.reply, /Aaj \(2026-10-17\)/);
  assert.match(s.reply, /Kal \(2026-10-16\)/);
});

test('mail-commands: Upstash na ho to saaf sandesh; status/keys/help phir bhi chalte hain', async () => {
  const over = { configured: false, today: {} };
  assert.match((await run('aaj', over)).reply, /UPSTASH_REDIS_REST_URL/);
  assert.match((await run('errors', over)).reply, /UPSTASH/);
  assert.match((await run('status', over)).reply, /Ginti \(Upstash\): band/);
  assert.match((await run('keys', over)).reply, /gemini: 1 key/);
});

test('mail-commands: khali din aur anjaan command', async () => {
  assert.match((await run('aaj', { today: {} })).reply, /koi sawal darj nahi/);
  assert.deepEqual(await run('hack'), { ok: false, reply: '' });
});

test('mail-commands: jawab mein koi key/token jaisi cheez nahi', async () => {
  for (const c of mc.COMMANDS) {
    const r = await run(c);
    assert.ok(!/AIza|gsk_|sk-|Bearer|password/i.test(r.reply), c);
  }
});
