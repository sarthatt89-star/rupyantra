// Rupeyantra AI - simple chat API (Vercel Serverless, Node)
// Needs ONE env variable in Vercel: GEMINI_API_KEY  (free key from https://aistudio.google.com/apikey)
// Optional: GEMINI_MODEL (default gemini-3.8-flash)

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const FALLBACK = process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-latest'; // used when the main model is busy
const MAX_MESSAGES = 20;          // last N messages are used
const MAX_TEXT = 12000;           // per message
const MAX_ATTACH = 3;
const MAX_B64 = 3300000;          // total attachment size (base64 chars)
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const LIMIT = 20, WINDOW = 60000; // 20 requests / minute / IP (per warm server)

const SYSTEM = `You are Rupeyantra AI, a friendly finance assistant for people in India.
- Reply in the user's language (English, Hindi or Hinglish). Keep answers short, clear and simple.
- Help with EMI, SIP, loans, FD, inflation, budgets, savings and everyday money questions. Use Indian units (Rs, lakh, crore).
- When you calculate, show the formula and steps, and state your assumptions. Double-check your arithmetic.
- You give general information, not personalised investment, tax or legal advice. For big decisions, suggest a SEBI-registered advisor or a CA.
- Do not invent current interest rates, tax slabs or scheme rules. If you are not sure, say so and suggest checking the official website (RBI, SEBI, Income Tax, bank).
- If a question is not about money or finance, politely say you only help with finance.
- Never claim an answer is "verified". Never ask for passwords, OTPs, PAN, Aadhaar or card numbers.`;

const hits = new Map();
function limited(ip) {
  const now = Date.now(), r = hits.get(ip);
  if (!r || now - r.t > WINDOW) { hits.set(ip, { t: now, n: 1 }); if (hits.size > 5000) hits.clear(); return false; }
  return ++r.n > LIMIT;
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let s = '';
  for await (const c of req) { s += c; if (s.length > 5e6) throw new Error('too big'); }
  return JSON.parse(s || '{}');
}

function build(messages) {
  let attached = 0, b64 = 0;
  const out = [];
  for (const m of messages.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = String(m.content || '').slice(0, MAX_TEXT);
    const parts = [];
    if (text) parts.push({ text });
    if (m.role === 'user' && Array.isArray(m.attachments)) {
      for (const a of m.attachments.slice(0, MAX_ATTACH)) {
        if (!a || !ALLOWED_MIME.includes(a.mime) || typeof a.data !== 'string') continue;
        if (!/^[A-Za-z0-9+/=]+$/.test(a.data)) continue;
        b64 += a.data.length;
        if (attached >= MAX_ATTACH || b64 > MAX_B64) continue;
        attached++;
        parts.push({ inline_data: { mime_type: a.mime, data: a.data } });
      }
    }
    if (!parts.length) continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].parts.push(...parts);
    else out.push({ role, parts });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET' && /(^|[?&])check=1(&|$)/.test(String(req.url).split('?')[1] || '')) {
    // Open /api/chat?check=1 in the browser to see why the chat fails (never shows the key)
    const k = process.env.GEMINI_API_KEY;
    if (!k) return send(res, 200, { key_set: false, fix: 'Add GEMINI_API_KEY in Vercel > Settings > Environment Variables, then Redeploy' });
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }] })
      });
      const t = (await r.text()).replace(k, '***').slice(0, 400);
      return send(res, 200, { key_set: true, model: MODEL, fallback: FALLBACK, google_status: r.status, google_reply: t });
    } catch (e) { return send(res, 200, { key_set: true, model: MODEL, fetch_error: String(e && e.message || e) }); }
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { message: 'Use POST' }); }
  const key = process.env.GEMINI_API_KEY;
  if (!key) return send(res, 404, { message: 'GEMINI_API_KEY is not set on the server' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return send(res, 429, { message: 'Too many requests' });

  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { message: 'Bad request' }); }
  if (!Array.isArray(body.messages)) return send(res, 400, { message: 'messages missing' });
  const contents = build(body.messages);
  if (!contents.length) return send(res, 400, { message: 'Empty message' });

  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
  });
  // each Google call gets 15 s; a hang counts as "busy" (503) so we move on to retry / fallback
  const call = async model => {
    try {
      return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: AbortSignal.timeout(15000), body: payload
      });
    } catch { return { ok: false, status: 503, text: async () => 'timeout' }; }
  };
  const sleep = ms => new Promise(x => setTimeout(x, ms));
  try {
    // Main model busy (503/500) -> retry once -> then the fallback model. Wrong main model name (404) -> fallback.
    let r;
    const plan = FALLBACK === MODEL ? [[MODEL, 2]] : [[MODEL, 2], [FALLBACK, 1]];
    for (const [model, tries] of plan) {
      for (let i = 0; i < tries; i++) {
        r = await call(model);
        if (r.ok || ![500, 503].includes(r.status)) break;
        if (i < tries - 1) await sleep(700);
      }
      if (r.ok || [400, 403, 429].includes(r.status)) break;
    }
    if (!r.ok) {
      if (r.status === 429) return send(res, 429, { message: 'Rate limit' });
      console.error('Gemini error', r.status, (await r.text()).slice(0, 300));
      return send(res, r.status >= 500 ? 503 : 502, { message: 'AI service error' });
    }
    const j = await r.json();
    const reply = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!reply) return send(res, 200, { reply: 'I could not answer that. Please rephrase your question.' });
    return send(res, 200, { reply });   // no "verified" flag: nothing here is verified
  } catch (e) {
    console.error('chat error', e && e.name);
    return send(res, 503, { message: 'AI service unavailable' });
  }
};
