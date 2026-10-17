'use strict';

/*
 * Rupeyantra Mail-Ask (api/mail-ask.js)
 *
 * Aap Gmail se "PIN 1234 status" jaisa mail bhejte ho; Google Apps Script use is raaste par bhejti hai,
 * aur yahan se jawab banke wapas aapko mail hota hai.
 *
 * Vercel env (dono zaroori, warna ye raasta hamesha 404 dega):
 *   MAIL_ASK_SECRET = lamba random code (kam se kam 16 akshar); Apps Script ke Script Properties mein bhi wahi
 *   MAIL_PIN        = aapka PIN (kam se kam 4 akshar)
 *
 * Niyam (tests/mail-ask.test.js mein lock):
 *  - Sirf POST, aur header "x-mail-secret" sahi ho; warna 404 (raasta hai ya nahi, pata na chale).
 *  - Galat PIN par kuch nahi (reply: null). 5 galat PIN ke baad 1 ghante tak sab band.
 *  - Sirf tay commands: status, keys, help. AI ya model ka koi use nahi; jawab tay text se bante hain.
 *  - Keys ki asli value, password ya user ka chat kabhi jawab mein nahi.
 *  - "keys" aur "status" har provider ki key ko live check karte hain (chhota, free models-list call).
 */

const crypto = require('node:crypto');
const eh = require('../lib/error-handler');
const keyPool = require('../lib/key-pool');
const alerts = require('../lib/alert');

const PROBE_TIMEOUT_MS = 4000;
const MAX_WRONG_PINS = 5;
const LOCK_MS = 60 * 60 * 1000;

const bearer = key => ({ Authorization: 'Bearer ' + key });

const PROVIDERS = [
  {
    label: 'Gemini', base: 'GEMINI_API_KEY',
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    headers: key => ({ 'x-goog-api-key': key })
  },
  { label: 'Groq', base: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/models', headers: bearer },
  { label: 'OpenRouter', base: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1/auth/key', headers: bearer },
  { label: 'OpenAI', base: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1/models', headers: bearer }
];

const sha = v => crypto.createHash('sha256').update(String(v)).digest();
const same = (expected, supplied) =>
  typeof supplied === 'string' && crypto.timingSafeEqual(sha(expected), sha(supplied.trim()));

function secretOk(supplied) {
  const expected = String(process.env.MAIL_ASK_SECRET || '').trim();
  return expected.length >= 16 && same(expected, supplied);
}

/* ---------- PIN (galat koshish par lock) ---------- */

let wrong = [];

function resetGuard() {
  wrong = [];
}

function pinState(supplied) {
  const now = Date.now();
  wrong = wrong.filter(t => now - t < LOCK_MS);
  if (wrong.length >= MAX_WRONG_PINS) return 'locked';

  const expected = String(process.env.MAIL_PIN || '').trim();
  if (expected.length < 4) return 'off';
  if (same(expected, supplied)) return 'ok';

  wrong.push(now);
  return 'wrong';
}

/* ---------- live key check ---------- */

async function probe(provider, key) {
  try {
    const r = await fetch(provider.url, {
      method: 'GET',
      headers: provider.headers(key),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (r.ok) return { ok: true, text: 'chal rahi hai' };

    let body = '';
    try { body = String(await r.text()).slice(0, 500); } catch (_) { /* ignore */ }

    if (/CONSUMER_SUSPENDED|suspended/i.test(body)) return { ok: false, text: 'project suspended (Google ne band kiya)' };
    if (r.status === 429) return { ok: false, text: 'limit par hai' };
    if (r.status === 401 || r.status === 403) return { ok: false, text: 'key kharab ya band hai' };
    if (r.status === 400 && /API_KEY_INVALID|not valid/i.test(body)) return { ok: false, text: 'key galat hai' };
    return { ok: false, text: 'dikkat (status ' + r.status + ')' };
  } catch (_) {
    return { ok: false, text: 'connect nahi ho paya' };
  }
}

async function probeAll() {
  return Promise.all(PROVIDERS.map(async p => {
    const keys = keyPool.readKeys(p.base);
    const results = await Promise.all(keys.map(k => probe(p, k)));
    return { label: p.label, results };
  }));
}

/* ---------- commands ---------- */

const NEEDS_REDIS = new Set(['aaj', 'errors', 'summary']);

const HELP = [
  'Commands:',
  'status: site aur AI providers ki halat',
  'keys: har key ki live jaanch',
  'help: ye list',
  '(aaj, errors, summary: Redis lagne ke baad aayenge)'
].join('\n');

const when = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';

async function runCommand(command) {
  const cmd = String(command || '').toLowerCase().trim().split(/\s+/)[0].slice(0, 20);

  if (cmd === 'help') return HELP;
  if (NEEDS_REDIS.has(cmd)) return 'Ye command abhi available nahi hai (Upstash Redis lagne ke baad aayega). Abhi: status, keys, help.';
  if (cmd !== 'status' && cmd !== 'keys') return "Ye command samajh nahi aaya. 'help' likh kar commands dekho.";

  const all = await probeAll();

  if (cmd === 'keys') {
    const lines = ['Keys ki live jaanch:'];
    for (const p of all) {
      if (!p.results.length) lines.push(p.label + ': key set nahi');
      else p.results.forEach((r, i) => lines.push(p.label + ' #' + (i + 1) + ': ' + r.text));
    }
    lines.push('', 'Kab: ' + when());
    return lines.join('\n');
  }

  const lines = ['Site: chal rahi hai'];
  for (const p of all) {
    if (!p.results.length) lines.push(p.label + ': key set nahi');
    else lines.push(p.label + ': ' + p.results.filter(r => r.ok).length + '/' + p.results.length + ' key chalu');
  }
  lines.push('Gmail alert: ' + (alerts.isConfigured() ? 'chalu' : 'band (env set nahi)'));
  lines.push('Kab: ' + when());
  return lines.join('\n');
}

/* ---------- handler ---------- */

const notFound = res => res.status(404).json({ message: 'Not found' });

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return notFound(res);
  if (!secretOk(req.headers && req.headers['x-mail-secret'])) return notFound(res);

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body && typeof body === 'object' ? body : {};

  // Galat/band PIN: chupchap koi jawab nahi (script mail ka jawab bhejegi hi nahi)
  if (pinState(body.pin) !== 'ok') return res.status(200).json({ reply: null });

  return res.status(200).json({ reply: await runCommand(body.command) });
}

module.exports = eh.wrapHandler(handler, { where: 'mail-ask' });

module.exports.__test = { runCommand, probeAll, resetGuard };
