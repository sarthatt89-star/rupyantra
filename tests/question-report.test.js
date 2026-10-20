'use strict';
// Run: npm test   (ya: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuestionReport } = require('../lib/question-report');
const { createHandler } = require('../api/admin/report');

function fakeStats(counters, available = true) {
  return {
    isConfigured: () => available,
    today: () => '2026-10-19',
    readDay: async d => ({ counters: d === '2026-10-19' ? counters : {}, available }),
  };
}

test('report: topic-wise asked aur missed, sort aur totals', async () => {
  const r = await createQuestionReport({ stats: fakeStats({
    requests: 10, ok: 8, fail: 1, fallback: 1, kb_hit: 2, glossary_hit: 1,
    'intent.emi': 4, 'miss.emi': 1, 'intent.sip': 3, 'intent.general': 2, 'miss.gst': 1,
    'provider.gemini.ok': 5, 'route.run_tool': 4,
  }) }).build();
  assert.equal(r.totals.asked, 10);
  assert.equal(r.totals.failed, 1);
  assert.equal(r.totals.knowledge, 2);
  assert.equal(r.topics[0].topic, 'emi');
  assert.deepEqual(r.topics[0], { topic: 'emi', asked: 4, missed: 1 });
  const gst = r.topics.find(t => t.topic === 'gst');
  assert.deepEqual(gst, { topic: 'gst', asked: 0, missed: 1 });
  assert.ok(!r.topics.some(t => t.topic === 'gemini' || t.topic === 'run_tool'));
});

test('report: Upstash band ho to available false aur khaali topics, crash nahi', async () => {
  const r = await createQuestionReport({ stats: fakeStats({}, false) }).build();
  assert.equal(r.available, false);
  assert.deepEqual(r.topics, []);
  assert.equal(r.totals.asked, 0);
});

test('report: day ka format galat ho to aaj ki report', async () => {
  const r = await createQuestionReport({ stats: fakeStats({ requests: 1 }) }).build('../../etc');
  assert.equal(r.day, '2026-10-19');
});

test('report: user ka text kabhi nahi, sirf topic naam', async () => {
  const r = await createQuestionReport({ stats: fakeStats({
    requests: 1, 'intent.emi': 1, 'user_text.secret': 1,
  }) }).build();
  assert.ok(!JSON.stringify(r).includes('secret'));
});

test('handler: login ke bina 401, login ke baad report', async () => {
  const auth = { checkSession: async t => (t === 'good' ? { email: 'a@b.com' } : null) };
  const handler = createHandler({ auth, report: createQuestionReport({ stats: fakeStats({ requests: 3, 'intent.sip': 2 }) }) });
  const mockRes = () => ({ code: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

  const no = mockRes();
  await handler({ method: 'GET', headers: {} }, no);
  assert.equal(no.code, 401);

  const ok = mockRes();
  await handler({ method: 'GET', headers: { cookie: 'rp_admin=good' }, query: {} }, ok);
  assert.equal(ok.code, 200);
  assert.equal(ok.body.topics[0].topic, 'sip');
});
