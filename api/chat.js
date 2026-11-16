
// Rupeyantra AI - simple chat API (Vercel Serverless, Node)
// Needs ONE env variable in Vercel: GROQ_API_KEY
// Optional: GROQ_MODEL, GROQ_FALLBACK_MODEL

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const FALLBACK = process.env.GROQ_FALLBACK_MODEL || '';

const MAX_MESSAGES = 20;
const MAX_TEXT = 12000;
const MAX_ATTACH = 3;
const MAX_B64 = 3300000;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const LIMIT = 20, WINDOW = 60000;

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

// Build Groq/OpenAI-compatible messages
function build(messages) {
  let attached = 0, b64 = 0;
  const out = [];

  for (const m of messages.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;

    const text = String(m.content || '').slice(0, MAX_TEXT);
    const parts = [];

    if (text) parts.push({ type: 'text', text });

    if (m.role === 'user' && Array.isArray(m.attachments)) {
      for (const a of m.attachments.slice(0, MAX_ATTACH)) {
        if (!a || !ALLOWED_MIME.includes(a.mime) || typeof a.data !== 'string') continue;
        if (!/^[A-Za-z0-9+/=]+$/.test(a.data)) continue;

        b64 += a.data.length;
        if (attached >= MAX_ATTACH || b64 > MAX_B64) continue;

        attached++;

        // Groq image input uses OpenAI-compatible image_url format.
        // PDF attachments are not supported by this chat-completions format.
        if (a.mime.startsWith('image/')) {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${a.mime};base64,${a.data}`
            }
          });
        }
      }
    }

    if (!parts.length) continue;

    const role = m.role === 'assistant' ? 'assistant' : 'user';

    const content = parts.length === 1 && parts[0].type === 'text'
      ? parts[0].text
      : parts;

    if (out.length && out[out.length - 1].role === role) {
      const previous = out[out.length - 1];

      if (typeof previous.content === 'string') {
        previous.content = [{ type: 'text', text: previous.content }];
      }

      if (typeof content === 'string') {
        previous.content.push({ type: 'text', text: content });
      } else {
        previous.content.push(...content);
      }
    } else {
      out.push({ role, content });
    }
  }

  while (out.length && out[0].role !== 'user') out.shift();

  return out;
}

// ---- Calculator system (separate Vercel project).
// Needs env: CALC_URL and CALC_TOKEN.
// If it is not set, is slow or fails, fall back to Groq.

async function askCalc(messages, ip, state, whatif) {
  const base = String(process.env.CALC_URL || '').trim().replace(/\/+$/, '');
  const token = process.env.CALC_TOKEN;

  if (!base || !token) return null;

  const last = messages[messages.length - 1];

  if (!whatif && (!last || last.role !== 'user' ||
    (Array.isArray(last.attachments) && last.attachments.length))) return null;

  try {
    const r = await fetch(base + '/api/calc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-calc-token': token,
        'x-client-id': ip
      },
      body: JSON.stringify({
        messages: messages.slice(-12).map(m => ({
          role: m && m.role === 'assistant' ? 'assistant' : 'user',
          content: String((m && m.content) || '').slice(0, 2000)
        })),
        state: state && typeof state === 'object' &&
          JSON.stringify(state).length < 3000 ? state : undefined,
        whatif: whatif && typeof whatif === 'object' &&
          !Array.isArray(whatif) && JSON.stringify(whatif).length < 400
          ? whatif : undefined
      }),
      signal: AbortSignal.timeout(6000)
    });

    if (!r.ok) return DOWN;

    const j = await r.json();

    if (!j || j.matched !== true ||
      typeof j.reply !== 'string' || !j.reply) return null;

    const out = { reply: j.reply, verified: j.verified === true };

    if (j.state && typeof j.state === 'object' &&
      typeof j.state.calculator === 'string' &&
      JSON.stringify(j.state).length < 3000) {
      out.state = j.state;
    }

    if (Array.isArray(j.sliders)) {
      out.sliders = j.sliders.slice(0, 3)
        .filter(x => x && typeof x.key === 'string')
        .map(x => ({
          key: String(x.key).slice(0, 20),
          label: String(x.label || '').slice(0, 60),
          min: +x.min,
          max: +x.max,
          step: +x.step,
          value: +x.value,
          unit: String(x.unit || '').slice(0, 10)
        }));
    }

    if (Array.isArray(j.assumptions)) {
      out.assumptions = j.assumptions.slice(0, 10)
        .map(x => String(x).slice(0, 300));
    }

    if (Array.isArray(j.blocks)) {
      out.blocks = j.blocks.slice(0, 6);
      if (/^https:\/\//.test(base)) out.viz = base + '/system2/';
    }

    return out;
  } catch {
    return DOWN;
  }
}

const DOWN = { down: true };

const SUMLIKE = /\d/;

const FINWORDS = /\b(emi|sip|swp|loan|interest|return|returns|invest\w*|fd|rd|ppf|gst|profit|loss|cagr|roi|lakh|crore|percent|tax|mortgage|compound|inflation|dividend|stock|share|bond|brokerage|margin|discount|rent\w*|salary|savings?|corpus|maturity|tenure)\b|%|₹|\brs\.?\b/i;

const looksLikeSum = t => SUMLIKE.test(t) && FINWORDS.test(t);

module.exports = async function handler(req, res) {

  // Health check
  if (req.method === 'GET' &&
    /(^|[?&])check=1(&|$)/.test(String(req.url).split('?')[1] || '')) {

    const k = process.env.GROQ_API_KEY;

    if (!k) {
      return send(res, 200, {
        key_set: false,
        fix: 'Add GROQ_API_KEY in Vercel > Settings > Environment Variables, then Redeploy'
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
              'Authorization': 'Bearer ' + k
            },
            signal: AbortSignal.timeout(12000),
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: 'Say OK' }],
              max_completion_tokens: 20
            })
          }
        );

        return r.status + (r.ok
          ? ' OK'
          : ' ' + (await r.text())
            .replace(k, '***')
            .replace(/\s+/g, ' ')
            .slice(0, 160));

      } catch {
        return 'no answer in 15s';
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

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { message: 'Use POST' });
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

  // 1) Calculator system first
  const calc = await askCalc(
    body.messages,
    ip,
    body.state,
    body.whatif
  );

  if (calc && calc.down) {
    const lastMsg = body.messages[body.messages.length - 1];

    if (lastMsg && lastMsg.role === 'user' &&
      looksLikeSum(String(lastMsg.content || ''))) {
      return send(res, 200, {
        reply: 'Our calculators are not reachable right now, so I cannot give you a reliable number for this. Please try again in a few minutes.'
      });
    }

  } else if (calc) {
    return send(res, 200, calc);
  }

  if (body.whatif) {
    return send(res, 200, {
      reply: 'Could not update the numbers right now. Please try again.',
      whatifFailed: true
    });
  }

  // 2) Everything else goes to Groq
  const key = process.env.GROQ_API_KEY;

  if (!key) {
    return send(res, 404, {
      message: 'GROQ_API_KEY is not set on the server'
    });
  }

  const messages = build(body.messages);

  if (!messages.length) {
    return send(res, 400, { message: 'Empty message' });
  }

  const payload = JSON.stringify({
    messages: [
      { role: 'system', content: SYSTEM },
      ...messages
    ],
    max_completion_tokens: 2048
  });

  const call = async model => {
    try {
      return await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + key
          },
          signal: AbortSignal.timeout(12000),
          body: JSON.stringify({
            ...JSON.parse(payload),
            model
          })
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
    // Main model busy -> retry -> optional fallback model.
    let r;

    const plan = FALLBACK && FALLBACK !== MODEL
      ? [[MODEL, 2], [FALLBACK, 1]]
      : [[MODEL, 3]];

    for (const [model, tries] of plan) {
      for (let i = 0; i < tries; i++) {
        r = await call(model);

        if (r.ok || ![500, 503].includes(r.status)) break;

        if (i < tries - 1) await sleep(700);
      }

      if (r.ok || [400, 401, 403, 429].includes(r.status)) break;
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

    const reply = j.choices?.[0]?.message?.content;

    if (!reply || typeof reply !== 'string') {
      return send(res, 200, {
        reply: 'I could not answer that. Please rephrase your question.'
      });
    }

    return send(res, 200, { reply: reply.trim() });

  } catch (e) {
    console.error('chat error', e && e.name);

    return send(res, 503, {
      message: 'AI service unavailable'
    });
  }
};
