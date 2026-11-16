
// Rupeyantra AI - Groq Chat API (Vercel Serverless, Node)
// Required Vercel env variable: GROQ_API_KEY
// Optional: GROQ_MODEL, GROQ_FALLBACK_MODEL

const MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const FALLBACK = process.env.GROQ_FALLBACK_MODEL || 'qwen/qwen3.6-27b';

const MAX_MESSAGES = 20;
const MAX_TEXT = 12000;
const MAX_ATTACH = 3;
const MAX_B64 = 3300000;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const LIMIT = 20, WINDOW = 60000;
const CALL_TIMEOUT = 18000;

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

  if (!r || now - r.t > WINDOW) {
    hits.set(ip, { t: now, n: 1 });
    if (hits.size > 5000) hits.clear();
    return false;
  }

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

  for await (const c of req) {
    s += c;
    if (s.length > 5e6) throw new Error('too big');
  }

  return JSON.parse(s || '{}');
}

function build(messages) {
  let attached = 0, b64 = 0;
  const out = [];

  for (const m of messages.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;

    const text = String(m.content || '').slice(0, MAX_TEXT);
    const parts = [];

    if (text) {
      parts.push({ type: 'text', text });
    }

    if (m.role === 'user' && Array.isArray(m.attachments)) {
      for (const a of m.attachments.slice(0, MAX_ATTACH)) {
        if (!a || !ALLOWED_MIME.includes(a.mime) || typeof a.data !== 'string') continue;
        if (!/^[A-Za-z0-9+/=]+$/.test(a.data)) continue;

        if (attached >= MAX_ATTACH || b64 + a.data.length > MAX_B64) continue;

        b64 += a.data.length;
        attached++;

        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${a.mime};base64,${a.data}`
          }
        });
      }
    }

    if (!parts.length) continue;

    const role = m.role;

    const content = role === 'assistant'
      ? text
      : parts;

    if (out.length && out[out.length - 1].role === role) {
      const previous = out[out.length - 1];

      if (Array.isArray(previous.content)) {
        previous.content.push(...parts);
      } else {
        previous.content += '\n' + text;
      }
    } else {
      out.push({ role, content });
    }
  }

  while (out.length && out[0].role !== 'user') out.shift();

  return out;
}

module.exports = async function handler(req, res) {

  // API connection check
  if (req.method === 'GET' &&
      /(^|[?&])check=1(&|$)/.test(String(req.url).split('?')[1] || '')) {

    const k = process.env.GROQ_API_KEY;

    if (!k) {
      return send(res, 200, {
        key_set: false,
        fix: 'Add GROQ_API_KEY in Vercel Environment Variables, then Redeploy'
      });
    }

    const probe = async model => {
      try {
        const r = await fetch(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${k}`
            },
            signal: AbortSignal.timeout(20000),
            body: JSON.stringify({
              model,
              messages: [
                { role: 'user', content: 'Say OK' }
              ],
              max_completion_tokens: 20
            })
          }
        );

        return r.status + (
          r.ok
            ? ' OK'
            : ' ' + (await r.text())
                .replace(k, '***')
                .replace(/\s+/g, ' ')
                .slice(0, 160)
        );

      } catch (e) {
        return 'no answer in 20s';
      }
    };

    const out = {
      key_set: true,
      main_model: MODEL,
      main: await probe(MODEL)
    };

    if (FALLBACK && FALLBACK !== MODEL) {
      out.fallback_model = FALLBACK;
      out.fallback = await probe(FALLBACK);
    }

    return send(res, 200, out);
  }

  // POST only
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { message: 'Use POST' });
  }

  const key = process.env.GROQ_API_KEY;

  if (!key) {
    return send(res, 404, {
      message: 'GROQ_API_KEY is not set on the server'
    });
  }

  const ip = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0].trim() || 'unknown';

  if (limited(ip)) {
    return send(res, 429, { message: 'Too many requests' });
  }

  let body;

  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, { message: 'Bad request' });
  }

  if (!Array.isArray(body.messages)) {
    return send(res, 400, { message: 'messages missing' });
  }

  // PDF is not accepted as inline image data
  const hasPdf = body.messages.some(m =>
    m &&
    m.role === 'user' &&
    Array.isArray(m.attachments) &&
    m.attachments.some(a => a && a.mime === 'application/pdf')
  );

  if (hasPdf) {
    return send(res, 400, {
      message: 'PDF attachments are not supported here. Please paste the PDF text instead.'
    });
  }

  const contents = build(body.messages);

  if (!contents.length) {
    return send(res, 400, { message: 'Empty message' });
  }

  const payload = JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      ...contents
    ],
    max_completion_tokens: 4096
  });

  // Groq API call
  const call = async model => {
    try {
      const requestBody = JSON.parse(payload);
      requestBody.model = model;

      return await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          signal: AbortSignal.timeout(CALL_TIMEOUT),
          body: JSON.stringify(requestBody)
        }
      );

    } catch {
      return {
        ok: false,
        status: 503,
        text: async () => 'timeout'
      };
    }
  };

  const sleep = ms => new Promise(x => setTimeout(x, ms));

  try {
    // Main model retry -> fallback model
    let r;
    const t0 = Date.now();

    const plan = FALLBACK && FALLBACK !== MODEL
      ? [[MODEL, 3], [FALLBACK, 2]]
      : [[MODEL, 4]];

    for (const [model, tries] of plan) {

      for (let i = 0; i < tries; i++) {

        if (r && Date.now() - t0 > 35000) break;

        r = await call(model);

        if (r.ok || ![500, 503].includes(r.status)) break;

        if (i < tries - 1) await sleep(1000);
      }

      if (r.ok || [400, 403, 429].includes(r.status)) break;
    }

    if (!r.ok) {

      if (r.status === 429) {
        return send(res, 429, { message: 'Rate limit' });
      }

      console.error(
        'Groq error',
        r.status,
        (await r.text()).slice(0, 300)
      );

      return send(res, r.status >= 500 ? 503 : 502, {
        message: 'AI service error'
      });
    }

    const j = await r.json();

    const reply = j.choices?.[0]?.message?.content?.trim() || '';

    if (!reply) {
      return send(res, 200, {
        reply: 'I could not answer that. Please rephrase your question.'
      });
    }

    return send(res, 200, { reply });

  } catch (e) {

    console.error('chat error', e && e.name);

    return send(res, 503, {
      message: 'AI service unavailable'
    });
  }
};
