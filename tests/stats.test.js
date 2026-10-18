'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStats, istDate } = require('../lib/stats');

function fakeRedis(configured = true, store = {}) {
  const calls = [];
  return {
    calls,
    isConfigured: () => configured,
    pipeline: async cmds => { calls.push(cmds); return cmds.map(() => 1); },
    cmd: async (...args) => (args[0] === 'HGETALL' ? store.hash : args[0] === 'LRANGE' ? store.list : null)
  };
}
const AT = Date.UTC(2026, 9, 16, 19, 0, 0); // 16 Oct 19:00 UTC = 17 Oct 00:30 IST

test('stats: din IST se tay hota hai', () => {
  assert.equal(istDate(AT), '2026-10-17');
  assert.equal(istDate(Date.UTC(2026, 9, 16, 12, 0, 0)), '2026-10-16');
});

test('stats: record counters ko HINCRBY + EXPIRE mein badalta hai', async () => {
  const redis = fakeRedis();
  const s = createStats({ redis, now: () => AT });
  assert.equal(await s.record({ requests: 1, ok: 1, 'provider.Gemini.ok': 1, zero: 0, bad: NaN }), true);
  const cmds = redis.calls[0];
  assert.deepEqual(cmds[0], ['HINCRBY', 'rupeyantra:stats:2026-10-17', 'requests', '1']);
  assert.deepEqual(cmds[2], ['HINCRBY', 'rupeyantra:stats:2026-10-17', 'provider.gemini.ok', '1']);
  assert.equal(cmds.length, 4);
  assert.deepEqual(cmds[3].slice(0, 2), ['EXPIRE', 'rupeyantra:stats:2026-10-17']);
});

test('stats: error entry mein sirf type/code/provider; user text jaisi cheezein saaf', async () => {
  const redis = fakeRedis();
  const s = createStats({ redis, now: () => AT });
  await s.record({ fail: 1 }, { type: 'server', code: 'HTTP_500', provider: 'gemini,groq', message: 'USER-TEXT-1', body: 'USER-TEXT-2' });
  const flat = JSON.stringify(redis.calls[0]);
  assert.ok(!flat.includes('USER-TEXT'));
  const push = redis.calls[0].find(c => c[0] === 'LPUSH');
  const entry = JSON.parse(push[2]);
  assert.deepEqual(Object.keys(entry).sort(), ['code', 'provider', 't', 'type']);
  assert.ok(redis.calls[0].some(c => c[0] === 'LTRIM'));

  const weird = createStats({ redis: fakeRedis(), now: () => AT });
  const r2 = fakeRedis();
  await createStats({ redis: r2, now: () => AT }).record({ fail: 1 }, { type: '<script>x</script>', code: 'a"b', provider: "p'q" });
  const e2 = JSON.parse(r2.calls[0].find(c => c[0] === 'LPUSH')[2]);
  assert.ok(!/[<>"']/.test(e2.type + e2.code + e2.provider));
  assert.ok(weird);
});

test('stats: Upstash na ho to chupchap false, koi call nahi', async () => {
  const redis = fakeRedis(false);
  const s = createStats({ redis, now: () => AT });
  assert.equal(await s.record({ requests: 1 }), false);
  assert.equal(redis.calls.length, 0);
  assert.deepEqual(await s.readDay(), { counters: {}, available: false });
  assert.deepEqual(await s.readRecentErrors(), []);
});

test('stats: readDay aur readRecentErrors data sahi padhte hain', async () => {
  const redis = fakeRedis(true, {
    hash: ['requests', '7', 'fail', '2', 'intent.emi', '3'],
    list: [JSON.stringify({ t: '2026-10-17T00:00:00.000Z', type: 'server' }), 'kharab-json']
  });
  const s = createStats({ redis, now: () => AT });
  const d = await s.readDay();
  assert.deepEqual(d, { counters: { requests: 7, fail: 2, 'intent.emi': 3 }, available: true });
  assert.equal(s.today(), '2026-10-17');
  assert.equal(s.yesterday(), '2026-10-16');
  const errs = await s.readRecentErrors(5);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].type, 'server');
});

test('stats: Redis fail ho to throw nahi karta', async () => {
  const boom = { isConfigured: () => true, pipeline: async () => { throw new Error('x'); }, cmd: async () => { throw new Error('x'); } };
  const s = createStats({ redis: boom });
  assert.equal(await s.record({ requests: 1 }), false);
  assert.equal((await s.readDay()).available, false);
  assert.deepEqual(await s.readRecentErrors(), []);
});
