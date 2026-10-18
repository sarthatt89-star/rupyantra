'use strict';
// Apps Script (apps-script/Code.gs) ka logic, Google ke objects ki nakal (stub) ke saath
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

function makeMessage({ from = 'Owner <owner@gmail.com>', subject = 'PIN Kx7mQ4pZ status', auth = 'mx.google.com; dkim=pass header.i=@gmail.com; spf=pass; dmarc=pass' } = {}) {
  return {
    getFrom: () => from,
    getSubject: () => subject,
    getRawContent: () => 'Received: x\r\nAuthentication-Results: ' + auth + '\r\nSubject: ' + subject + '\r\n\r\nbody SECRET-BODY-TEXT'
  };
}

function setup({ messages = [makeMessage()], fetchImpl, props = { SITE_URL: 'https://site.example/', MAIL_ASK_SECRET: 'sec-123' }, replyLog } = {}) {
  const sent = [];
  const labelled = [];
  const fetched = [];
  const logs = [];
  const store = { ...props };
  if (replyLog) store.REPLY_LOG = JSON.stringify(replyLog);
  const done = { name: 'rupeyantra-done' };
  const threads = messages.map(m => ({ getMessages: () => [m], addLabel: l => labelled.push([m.getSubject(), l.name]) }));
  const ctx = {
    Logger: { log: s => logs.push(String(s)) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = v; } }) },
    GmailApp: {
      getUserLabelByName: () => done, createLabel: () => done,
      search: () => threads,
      sendEmail: (to, subject, body) => sent.push({ to, subject, body })
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        fetched.push({ url, opts });
        return (fetchImpl || (() => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, subject: '[Rupeyantra] Jawab: status', reply: 'sab theek' }) })))(url, opts);
      }
    },
    JSON, RegExp, Date, String, Object, Array
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, sent, labelled, fetched, logs, store };
}

test('apps script: sahi mail par site ko sirf from/subject/auth jaata hai, body nahi; jawab reply hota hai', () => {
  const s = setup();
  s.ctx.checkMail();
  assert.equal(s.fetched.length, 1);
  assert.equal(s.fetched[0].url, 'https://site.example/api/mail-ask');
  assert.equal(s.fetched[0].opts.headers['x-mail-secret'], 'sec-123');
  const payload = JSON.parse(s.fetched[0].opts.payload);
  assert.deepEqual(Object.keys(payload).sort(), ['auth', 'from', 'subject']);
  assert.deepEqual(payload.auth, { spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  assert.ok(!s.fetched[0].opts.payload.includes('SECRET-BODY-TEXT'));
  assert.deepEqual(s.sent, [{ to: 'owner@gmail.com', subject: '[Rupeyantra] Jawab: status', body: 'sab theek' }]);
  assert.equal(s.labelled.length, 1);
});

test('apps script: apna hi "[Rupeyantra]" wala jawab command nahi maana jaata', () => {
  const s = setup({ messages: [makeMessage({ subject: '[Rupeyantra] Jawab: status PIN Kx7mQ4pZ' })] });
  s.ctx.checkMail();
  assert.equal(s.fetched.length, 0);
  assert.equal(s.sent.length, 0);
  assert.equal(s.labelled.length, 1);
});

test('apps script: site ne ok:false diya to reply nahi, par mail done ho jaati hai', () => {
  const s = setup({ fetchImpl: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: false, reason: 'pin_galat' }) }) });
  s.ctx.checkMail();
  assert.equal(s.sent.length, 0);
  assert.equal(s.labelled.length, 1);
  assert.ok(s.logs.some(l => l.includes('pin_galat')));
});

test('apps script: site down (500 ya network error) par label nahi lagta, agli baar dobara', () => {
  for (const f of [() => ({ getResponseCode: () => 503, getContentText: () => '' }), () => { throw new Error('net'); }]) {
    const s = setup({ fetchImpl: f });
    s.ctx.checkMail();
    assert.equal(s.sent.length, 0);
    assert.equal(s.labelled.length, 0);
  }
});

test('apps script: 404 par saaf wajah log hoti hai', () => {
  const s = setup({ fetchImpl: () => ({ getResponseCode: () => 404, getContentText: () => '' }) });
  s.ctx.checkMail();
  assert.ok(s.logs.some(l => l.includes('404')));
});

test('apps script: properties na hon to kuch nahi; ghante ki limit par ruk jaata hai', () => {
  const none = setup({ props: {} });
  none.ctx.checkMail();
  assert.equal(none.fetched.length, 0);
  assert.ok(none.logs.some(l => l.includes('SITE_URL')));

  const now = Date.now();
  const capped = setup({ replyLog: Array.from({ length: 20 }, () => now) });
  capped.ctx.checkMail();
  assert.equal(capped.fetched.length, 0);

  const old = setup({ replyLog: Array.from({ length: 20 }, () => now - 2 * 3600000) });
  old.ctx.checkMail();
  assert.equal(old.fetched.length, 1);
});

test('apps script: Authentication-Results ke alag roop padhta hai', () => {
  const fail = setup({ messages: [makeMessage({ auth: 'mx.google.com; spf=fail; dkim=none; dmarc=fail' })] });
  fail.ctx.checkMail();
  assert.deepEqual(JSON.parse(fail.fetched[0].opts.payload).auth, { spf: 'fail', dkim: 'none', dmarc: 'fail' });
  const folded = setup({ messages: [{ ...makeMessage(), getRawContent: () => 'Authentication-Results: mx.google.com;\r\n dkim=pass header.i=@gmail.com;\r\n spf=pass\r\nSubject: x\r\n\r\nbody' }] });
  folded.ctx.checkMail();
  assert.deepEqual(JSON.parse(folded.fetched[0].opts.payload).auth, { spf: 'pass', dkim: 'pass', dmarc: 'none' });
});
