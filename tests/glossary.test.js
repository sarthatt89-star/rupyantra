'use strict';
// Run: npm test   (ya: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGlossary, norm } = require('../lib/glossary');
const { createHandler } = require('../api/admin/glossary');

function fakeRedis({ down = false } = {}) {
  const hash = new Map();
  return {
    hash,
    async cmd(...a) {
      if (down) return null;
      const [op, k, f, v] = a;
      if (op === 'HSET') { const had = hash.has(f); hash.set(f, String(v)); return had ? 0 : 1; }
      if (op === 'HGET') return hash.has(f) ? hash.get(f) : null;
      if (op === 'HDEL') return hash.delete(f) ? 1 : 0;
      if (op === 'HGETALL') { const out = []; for (const [kk, vv] of hash) out.push(kk, vv); return out; }
      throw new Error('unsupported ' + op);
    },
  };
}

test('save: naya term, update, aur validation', async () => {
  const g = createGlossary({ redis: fakeRedis() });
  const a = await g.save('SIP', 'SIP ek tarika hai jisme har mahine ek tay rakam invest hoti hai.');
  assert.equal(a.ok, true);
  assert.equal((await g.list()).length, 1);
  const upd = await g.save('sip', 'SIP ka matlab nayi line ke saath, ab bhi kaafi lamba text hai yahan.');
  assert.equal(upd.ok, true);
  assert.equal((await g.list()).length, 1);
  assert.equal((await g.save('A', 'bahut chhota term')).error, 'term_length');
  assert.equal((await g.save('Test', 'short')).error, 'text_length');
  assert.equal((await g.save('Test', '<script>alert(1)</script> lamba text yahan')).error, 'bad_chars');
});

test('save: Upstash fail ho to store_failed, crash nahi', async () => {
  const g = createGlossary({ redis: fakeRedis({ down: true }) });
  const r = await g.save('SIP', 'SIP ek tarika hai jisme har mahine ek tay rakam invest hoti hai.');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'store_failed');
});

test('lookup: general sawal mein term mile to entry; number wale ya lambe sawal par nahi', async () => {
  const g = createGlossary({ redis: fakeRedis() });
  await g.save('SIP', 'SIP ek tarika hai jisme har mahine ek tay rakam invest hoti hai.');
  await g.save('Nifty', 'Nifty NSE ke 50 badi companies ka index hai, bazaar ka haal batata hai.');
  assert.equal((await g.lookup('SIP kya hai?')).term, 'SIP');
  assert.equal((await g.lookup('mujhe bata do nifty kya hai')).term, 'Nifty');
  assert.equal(await g.lookup('SIP ka 10 saal ka future value batao'), null);
  assert.equal(await g.lookup('kal ka weather kaisa hai'), null);
});

test('lookup: longest term jeetta hai; Upstash down ho to null', async () => {
  const g = createGlossary({ redis: fakeRedis() });
  await g.save('fund', 'Mutual fund paise ko bahut sare logon se milkar invest karne ka tarika hai.');
  await g.save('mutual fund', 'Mutual fund ek pool hai jisme kai investors ka paisa ek saath lagta hai.');
  assert.equal((await g.lookup('mutual fund kya hai')).term, 'mutual fund');
  const down = createGlossary({ redis: fakeRedis({ down: true }) });
  assert.equal(await down.lookup('SIP kya hai'), null);
});

test('remove: hatana aur na-mile term', async () => {
  const g = createGlossary({ redis: fakeRedis() });
  await g.save('SIP', 'SIP ek tarika hai jisme har mahine ek tay rakam invest hoti hai.');
  assert.equal((await g.remove('SIP')).removed, true);
  assert.equal((await g.remove('SIP')).removed, false);
  assert.equal(norm('  SIP!! '), 'sip');
});

/* ---------- HTTP ---------- */

function mockRes() {
  return {
    code: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const logged = { checkSession: async t => (t === 'good' ? { email: 'a@b.com' } : null) };
const call = (handler, o = {}) => {
  const res = mockRes();
  return handler({
    method: o.method || 'GET', query: o.query || {}, body: o.body,
    headers: { host: 'rupyantra-psi.vercel.app', cookie: o.cookie === undefined ? 'rp_admin=good' : o.cookie, origin: o.origin },
  }, res).then(() => res);
};

test('handler: login ke bina 401; save, list aur delete', async () => {
  const handler = createHandler({ auth: logged, glossary: createGlossary({ redis: fakeRedis() }) });
  assert.equal((await call(handler, { cookie: '' })).code, 401);

  const saved = await call(handler, { method: 'POST', body: { term: 'EMI', text: 'EMI wo fixed rakam hai jo har mahine loan ke liye di jaati hai.' } });
  assert.equal(saved.code, 200);

  const list = await call(handler);
  assert.equal(list.body.entries.length, 1);

  const del = await call(handler, { method: 'DELETE', query: { term: 'EMI' } });
  assert.equal(del.body.removed, true);
});

test('handler: alag origin par POST 403, galat text par 400 saaf message', async () => {
  const handler = createHandler({ auth: logged, glossary: createGlossary({ redis: fakeRedis() }) });
  assert.equal((await call(handler, { method: 'POST', origin: 'https://evil.example', body: { term: 'EMI', text: 'kuch bhi lamba text yahan' } })).code, 403);
  const bad = await call(handler, { method: 'POST', body: { term: 'E', text: 'x' } });
  assert.equal(bad.code, 400);
  assert.match(bad.body.message, /Term 2/);
});
