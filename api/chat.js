'use strict';

/*
 * Rupeyantra AI backend (api/chat.js)
 *
 * Is file mein koi formula nahi; sirf wiring hai:
 *  - lib/intent-router.js     : message dekh kar route batata hai (blocked / clarification / tool / verify / document / chat)
 *  - lib/finance-engine.js    : calculators, conversation context, reply ke numbers ki verification
 *  - lib/finance-validator.js : tool result ka independent cross-check, claim check, injection/sensitive-data guard, safe log
 *  - lib/error-handler.js     : retry, timeout, circuit breaker, friendly errors, request id, safe logging
 *  - lib/providers.js         : saare AI providers ki list; koi bhi key (naam kuch bhi, ya AI_KEYS) apne aap pehchani jaati hai
 *  - lib/provider-router.js   : sawal ke type ke hisaab se kaun sa provider pehle (media/facts/calc/chat/long)
 *  - lib/key-pool.js          : har provider ki kai API keys; ek ki limit khatam to agli key chalti hai
 *  - lib/system-prompt.js     : AI ke saare prompts / niyam
 *  - lib/knowledge-base.js    : aam concept sawalon ke tayyar jawab (AI/API ke bina)
 *  - lib/alert.js             : zaroori dikkat par Gmail alert (throttle ke saath)
 *  - lib/stats.js             : roz ki ginti Upstash mein (sirf ginti, user ka text kabhi nahi)
 *
 * Request flow:
 *   1. wrapHandler (request id + koi bhi throw => sanitized JSON), rate limit, body/attachment checks
 *   2. router.route()  -> blocked / ask_upload / ask_clarification ho to seedha jawab (LLM call nahi)
 *   3. official facts chahiye to verifiedLookup()
 *   4. Providers (providers.PRIORITY order: Gemini, Groq, baaki, OpenRouter, OpenAI; jiski key ho, circuit breaker ke saath);
 *      har provider ke andar keys ek ke baad ek (limit/quota par agli key); tool result checkedRun() se guzarta hai
 *   5. reply ke numbers/claims verify; fail ho to ek correction retry, phir safe fallback
 *   6. saare providers fail hon par bhi inputs poore hon to calculator ka result seedha dikhta hai
 *   7. Jawab verify hone ke BAAD hi bheja jaata hai. Browser ne Accept: text/event-stream bheja ho to jawab
 *      tukdon mein stream hota hai (respondOk), warna normal JSON. Kacha/unverified text kabhi stream nahi hota.
 *
 * Ek se zyada sawal: jin calculations ke inputs poore hain wo chalti hain, kami wali details jawab ke ant mein
 * ek saath poochhi jaati hain (route.pending_questions); sirf concept wale hisse bina numbers ke samjhaye jaate hain.
 *
 * Vercel env (sab optional; jiski key ho wahi provider chalega):
 *   Keys: GEMINI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, SAMBANOVA_API_KEY ... (_1.._10, ya ..._KEYS=k1,k2)
 *         ya ek hi AI_KEYS=key1,key2,deepseek:key3  ya koi bhi env jiska naam KEY/KEYS par khatam ho
 *   Model: GEMINI_MODEL, GEMINI_SEARCH_MODEL, OPENAI_MODEL, GROQ_MODEL, OPENROUTER_MODEL, OPENROUTER_VISION_MODEL, <NAAM>_MODEL
 *   DEBUG_ERRORS=1 (sirf temporary debugging ke liye)
 */

const engine = require('../lib/finance-engine');
const eh = require('../lib/error-handler');
const router = require('../lib/intent-router');
const validator = require('../lib/finance-validator');
const keyPool = require('../lib/key-pool');
const providers = require('../lib/providers');
const providerRouter = require('../lib/provider-router');
const knowledge = require('../lib/knowledge-base');
const alerts = require('../lib/alert');
const stats = require('../lib/stats');
const glossary = require('../lib/glossary');
const crypto = require('node:crypto');

/* ---------- prompts ---------- */

const { SYSTEM, DOC_RULES, LOOKUP_SYSTEM, UNVERIFIED_REPLY, verificationBlock } = require('../lib/system-prompt');

// C++ engine tools (simulations, prepayment, tax, rate table). Never throws; if it cannot install, the site works as before.
require('../lib/cpp-integration').install();

// sys order: SYSTEM -> aaj ki tareekh -> engine hint -> router hint -> DOC_RULES -> verification -> correction
function sys(messages, opts = {}) {
  const today = new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });

  let prompt = SYSTEM + '\n\nAaj ki tareekh (India): ' + today + '.';

  try {
    prompt += engine.promptHint(messages);
  } catch (e) {
    eh.logError(e, { where: 'engine_hint' });
  }

  if (opts.route) {
    try {
      prompt += router.promptHint(opts.route);
    } catch (e) {
      eh.logError(e, { where: 'router_hint' });
    }
  }

  if (opts.hasMedia) prompt += DOC_RULES;
  if (opts.verification) prompt += verificationBlock(opts.verification);
  if (opts.correction) prompt += '\n\nSudhaar: ' + opts.correction;
  return prompt;
}

/* ---------- limits ---------- */

const TIMEOUT = 15000;
const LOOKUP_TIMEOUT = 12000;
const TOTAL_BUDGET = 45000; // vercel.json maxDuration (60s) se kam
const MAX_RETRIES = 1;
const MAX_MESSAGES = 20;
const MAX_CONTENT_CHARS = 12000;
const MAX_ATTACHMENTS = 3;
const MAX_MEDIA_CHARS = 3500000; // base64 chars, sirf naye message ke total
const MAX_REQUEST_CHARS = 4200000; // Vercel body limit 4.5 MB hai
const MAX_OUTPUT_TOKENS = 1200;
const OPENAI_OUTPUT_TOKENS = 2000;
const GEMINI_OUTPUT_TOKENS = 2000;
const MIN_RETRY_TIME = 8000; // itna time bacha ho tabhi correction retry
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const DEFAULT_ATTACHMENT_TEXT =
  'Is attachment ko dekho. Batao isme kya hai aur main figures kya dikh rahe hain.';
const OLD_ATTACHMENT_TEXT = '(pehle ek attachment bheja gaya tha)';

// Gemini 3.x: temperature/top-p/top-k ab ignore hote hain, isliye bheje nahi jaate.
// thinkingBudget ki jagah thinkingLevel (dono ek saath mat bhejo).
const GEMINI_FALLBACK = 'gemini-3.5-flash-lite';

function geminiConfig(model, maxOutputTokens) {
  const cfg = { maxOutputTokens };
  if (!/pro/i.test(model)) cfg.thinkingConfig = { thinkingLevel: 'low' };
  return cfg;
}

// Router ke ye actions bina LLM ke seedha jawab bante hain. Kisi ko LLM par chhodna ho to yahan se hata do.
const DIRECT_ACTIONS = new Set(['blocked', 'ask_upload', 'ask_clarification']);

// Lagataar fail hone wala provider thodi der ke liye skip hota hai (per warm instance)
const breaker = eh.createCircuitBreaker({ failureThreshold: 5, cooldownMs: 20000 });

/* ---------- API key pools (har provider ki kai keys; lib/providers.js se) ---------- */

const POOLS = providers.makePools();

// Keys ke saath chalata hai; key kharab ya limit par ho to aapko Gmail alert (throttle ke saath) jaata hai
const viaKeys = (pool, name, fn) => keyPool.withKeys(pool, name, fn, {
  onRotate: async (type, slot) => {
    await stats.record(
      { ['rotate.' + type]: 1, ['rotate.' + type + '.' + String(name).toLowerCase()]: 1 },
      { type: 'key_' + type, code: '', provider: slot }
    );
    await alerts.sendAlert(
      type === 'auth' ? 'urgent' : 'warning',
      type === 'auth' ? 'API key kharab hai ya billing ki dikkat' : 'API key ki limit khatam (agli key chalu hui)',
      { provider: name, slot, kind: type },
      { timeoutMs: 3000 }
    );
  }
});

/* ---------- untrusted text + sensitive data (LLM tak jaane se pehle) ---------- */

const FILE_BLOCK_RE = /\[FILE: [^\]\n]{0,120}\][\s\S]*?(?:\[FILE END\]|$)/g;

// User message jab LLM ko jaata hai: purane OTP/card jaisi cheezein mask, [FILE: ...] block "sirf data" ban jaata hai.
// Engine/router/verifier hamesha original text dekhte hain; ye sirf wire par lagta hai.
function shield(text) {
  let t = String(text || '');
  try {
    if (validator.detectSensitiveData(t).found) t = validator.redactText(t);
    if (t.includes('[FILE: ')) {
      t = t.replace(FILE_BLOCK_RE, block => validator.neutralizeUntrusted(block, 'FILE').text);
    }
  } catch (_) { /* shield fail ho to original text */ }
  return t;
}

/* ---------- tool schemas (calculators engine se aate hain) ---------- */

function schema(tool, gemini = false) {
  const properties = {};
  for (const [k, description] of Object.entries(tool.params)) {
    properties[k] = { type: gemini ? 'NUMBER' : 'number', description };
  }
  return gemini
    ? { type: 'OBJECT', properties, required: tool.required }
    : { type: 'object', properties, required: tool.required };
}

const OPENAI_TOOLS = engine.TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: schema(t) }
}));

const GEMINI_TOOLS = [{
  functionDeclarations: engine.TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    parameters: schema(t, true)
  }))
}];

/* ---------- checked tool run: engine -> error-handler guard -> validator cross-check ---------- */

const okCall = c => Boolean(c && c.result && typeof c.result === 'object' && !c.result.error);

// formatINR har amount ko alag-alag nearest rupee par gol karta hai, isliye GST ke ye do checks
// (base+gst=total, gst=base*rate) validator ke 0.03 tolerance par inclusive GST mein jhootha fail hote hain.
// Inko 1 rupaye tak ki gol-chhoot ke saath maana jaata hai; baaki checks (total/base = input) sakht rehte hain.
const ROUNDING_SENSITIVE = { calc_gst: new Set(['base+gst=total', 'gst=base*rate']) };

function independentCheck(name, args, result) {
  const v = validator.verifyCalculation(name, args, result);
  if (v.ok) return { ok: true, names: [] };

  const checks = Array.isArray(v.checks) ? v.checks : [];
  const failed = checks.filter(c => !c.ok);
  const soft = ROUNDING_SENSITIVE[name];

  if (soft && failed.length && (v.errors || []).every(e => e.code === 'CALC_MISMATCH')) {
    const real = failed.filter(c => !(soft.has(c.name) && Math.abs(c.expected - c.got) <= 1.01));
    if (!real.length) return { ok: true, names: [] };
  }
  return { ok: false, names: failed.map(c => c.name) };
}

function checkedRun(name, args) {
  let result;
  try {
    result = engine.runTool(name, args);
  } catch (e) {
    eh.logError(e, { where: 'engine_runTool' });
    return { error: 'Calculation error' };
  }
  if (!result || typeof result !== 'object') return { error: 'Calculation error' };
  if (result.error) return result;

  try {
    const g = eh.guardToolResult(name, args, result);
    if (!g.ok) {
      eh.logError(g.error, { where: 'tool_guard' });
      return { error: 'Is calculation ka result jaanch mein pass nahi hua, isliye number nahi dikha sakte.' };
    }

    const c = independentCheck(name, args, result);
    if (!c.ok) {
      eh.logError(
        new eh.AppError({
          type: eh.ERROR_TYPES.CALCULATION,
          message: 'tool cross-check failed: ' + name + ' [' + c.names.join(',') + ']',
          code: 'CALC_INVALID'
        }),
        { where: 'tool_crosscheck' }
      );
      return { error: 'Is calculation ka result independent check se match nahi hua, isliye number nahi dikha sakte.' };
    }

    // validator ki chetavaniyan (jaise "rate bahut zyada") model ko result ke saath milti hain
    const iv = validator.validateInputs(name, args);
    const notes = (iv.warnings || []).filter(w => w.confirm).map(w => w.message);
    notes.push(...validator.edgeNotes(name, iv.values));
    if (notes.length) return Object.assign({}, result, { validator_notes: [...new Set(notes)] });
  } catch (e) {
    // checker khud fail ho to engine ka result rakho; availability pehle
    eh.logError(e, { where: 'tool_checkers' });
  }
  return result;
}

function runFromContext(ctx) {
  if (!ctx || !ctx.tool || !ctx.complete) return null;
  const args = { ...ctx.inputs };
  return { name: ctx.tool, args, result: checkedRun(ctx.tool, args) };
}

// multi-intent: router ke complete steps ko calculator se chalata hai
function stepCalls(route) {
  if (!route || !Array.isArray(route.steps)) return [];
  return route.steps
    .filter(s => s && s.complete && s.tool)
    .map(s => {
      const args = { ...s.inputs };
      return { name: s.tool, args, result: checkedRun(s.tool, args) };
    });
}

// Multi-sawal mein jin calculations ke inputs kam the, unki details jawab ke ant mein ek saath
const pendingNote = route =>
  route && Array.isArray(route.pending_questions) && route.pending_questions.length
    ? '\n\nAur in ke liye ye details chahiye:\n' + route.pending_questions.join('\n')
    : '';

const inputNum = v => (typeof v === 'boolean' ? (v ? 1 : 0) : Number(String(v).replace(/[₹,\s]/g, '')));

function sameInput(tool, key, want, args) {
  const w = inputNum(want);
  if (tool === 'calc_emi' && (key === 'years' || key === 'months')) {
    const has = v => v !== undefined && v !== null && v !== '';
    const months = has(args.months) ? inputNum(args.months) : inputNum(args.years) * 12;
    return Math.abs(months - (key === 'years' ? w * 12 : w)) <= 0.5;
  }
  const got = inputNum(args[key]);
  return Math.abs(got - w) <= 1e-6 * Math.max(1, Math.abs(w));
}

// Multi-intent mein model ne kisi tool ko user se alag inputs (jaise 50 lakh ki jagah 50000) se chalaya?
function stepMismatch(route, calls) {
  if (!route || !Array.isArray(route.steps)) return [];
  const bad = [];
  for (const s of route.steps) {
    if (!s || !s.complete || !s.tool) continue;
    const mine = calls.filter(c => c.name === s.tool && okCall(c));
    if (!mine.length) continue; // tool chala hi nahi => missing tools pakadta hai
    const entries = Object.entries(s.inputs || {}).filter(([, v]) => v !== undefined && v !== null && Number.isFinite(inputNum(v)));
    if (!mine.some(c => entries.every(([k, v]) => sameInput(s.tool, k, v, c.args || {})))) bad.push(s.tool);
  }
  return bad;
}

/* ---------- HTTP with timeout + retry (error-handler) ---------- */

async function fail(name, response) {
  let body = '';
  try {
    body = (await response.text()).slice(0, 300);
  } catch (_) {}
  throw Object.assign(new Error(`${name} HTTP ${response.status}: ${body}`), {
    status: response.status,
    headers: response.headers
  });
}

// fast = true: aur keys bachi hain, isliye 429 par wahi key dobara try nahi karte (seedha agli key)
async function post(name, url, headers, body, deadline, timeout = TIMEOUT, fast = false) {
  const payload = JSON.stringify(body);

  return eh.retry(async () => {
    const remaining = deadline - Date.now();
    if (remaining < 1500) {
      throw new eh.AppError({
        type: eh.ERROR_TYPES.TIMEOUT,
        message: name + ' time budget khatam',
        code: 'TIME_BUDGET',
        retryable: false
      });
    }

    const r = await eh.withTimeout(
      signal => fetch(url, { method: 'POST', headers, body: payload, signal }),
      Math.min(timeout, remaining),
      name
    );
    if (r.ok) return r;
    return fail(name, r);
  }, {
    retries: MAX_RETRIES,
    deadlineAt: deadline,
    maxRetryAfterMs: 2000,
    // apna timeout dobara try karne se budget jaata hai; provider ka 5xx/429 retry hota hai
    shouldRetry: info => info.retryable &&
      !(info.type === eh.ERROR_TYPES.TIMEOUT && !info.upstreamStatus) &&
      !(fast && info.type === eh.ERROR_TYPES.RATE_LIMIT),
    ctx: { provider: name, source: 'provider' }
  });
}

// Response body padhne par bhi time limit
const readJson = (name, r, deadline) =>
  eh.withTimeout(r.json(), Math.max(1500, Math.min(TIMEOUT, deadline - Date.now())), name + ' body');

/* ---------- OpenAI / Groq / OpenRouter / baaki (OpenAI-compatible) ---------- */

// allowPdf: sirf OpenAI ke liye (PDF 'file' part); baaki mein sirf photo jaati hai
function toOpenAI(m, allowPdf = false) {
  const text = m.role === 'user' ? shield(m.content) : m.content;
  const files = (m.attachments || []).filter(a =>
    a.mime.startsWith('image/') || (allowPdf && a.mime === 'application/pdf'));
  if (!files.length) return { role: m.role, content: text };
  return {
    role: m.role,
    content: [
      { type: 'text', text },
      ...files.map(a => (a.mime === 'application/pdf'
        ? { type: 'file', file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${a.data}` } }
        : { type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}` } }))
    ]
  };
}

// Ek key se poori baatcheet (tool calls ke saath). Key badalne par ye function naye sire se chalta hai.
async function openaiChat({
  name, url, key, fast, model, messages, opts,
  pdf = false, tokenKey = 'max_tokens', maxTokens = MAX_OUTPUT_TOKENS, temperature = 0.2
}) {
  if (!key) throw new Error(name + ' API key missing');

  const convo = [
    { role: 'system', content: sys(messages, opts) },
    ...messages.map(m => toOpenAI(m, pdf))
  ];
  const calls = [];

  for (let i = 0; i < 5; i++) {
    const body = {
      model,
      messages: convo,
      tools: OPENAI_TOOLS,
      tool_choice: i === 0 && opts.force ? 'required' : 'auto'
    };
    body[tokenKey] = maxTokens;
    if (temperature !== null) body.temperature = temperature; // null = temperature mat bhejo

    const r = await post(
      name,
      url,
      { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body,
      opts.deadline,
      TIMEOUT,
      fast
    );

    const msg = (await readJson(name, r, opts.deadline)).choices?.[0]?.message;
    if (!msg) throw new Error(name + ' se khali jawab mila');

    if (msg.tool_calls?.length) {
      convo.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.tool_calls
      });

      for (const tc of msg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch (_) {}

        const result = checkedRun(tc.function?.name, args);
        calls.push({ name: tc.function?.name, args, result });
        convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }

    if (typeof msg.content !== 'string' || !msg.content.trim()) {
      throw new Error(name + ' se khali jawab mila');
    }
    return { text: msg.content.trim(), calls };
  }

  throw new Error(name + ' tool-call limit poora ho gaya');
}

// OpenAI: photo + PDF dono. Model env OPENAI_MODEL se badal sakte ho.
// max_completion_tokens + bina temperature: naye (reasoning) models bhi chalte hain.
const askOpenAI = (messages, opts) => viaKeys(POOLS.openai, 'OpenAI', slot => openaiChat({
  name: 'OpenAI',
  url: 'https://api.openai.com/v1/chat/completions',
  key: slot.key,
  fast: slot.fast,
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  messages,
  opts,
  pdf: true,
  tokenKey: 'max_completion_tokens',
  maxTokens: OPENAI_OUTPUT_TOKENS,
  temperature: null
}));

const askGroq = (messages, opts) => viaKeys(POOLS.groq, 'Groq', slot => openaiChat({
  name: 'Groq',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  key: slot.key,
  fast: slot.fast,
  model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  messages,
  opts
}));

const askOpenRouter = (messages, opts) => viaKeys(POOLS.openrouter, 'OpenRouter', slot => openaiChat({
  name: 'OpenRouter',
  url: 'https://openrouter.ai/api/v1/chat/completions',
  key: slot.key,
  fast: slot.fast,
  model: messages.some(m => m.attachments?.length)
    ? (process.env.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-flash')
    : (process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct'),
  messages,
  opts
}));

// Baaki sab OpenAI-compatible providers (SambaNova, Cerebras, Mistral, DeepSeek, Together, xAI, custom ...)
const askCompat = def => (messages, opts) => viaKeys(POOLS[def.name], def.label, slot => openaiChat({
  name: def.label,
  url: providers.urlOf(def),
  key: slot.key,
  fast: slot.fast,
  model: providers.modelOf(def),
  messages,
  opts
}));

/* ---------- Gemini ---------- */

const GEMINI_URL = model =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Ek model + ek key se poori baatcheet
async function geminiCall(model, messages, opts, slot) {
  if (!slot || !slot.key) throw new Error('GEMINI_API_KEY missing');

  const contents = messages.map(m => {
    const parts = [];
    if (m.content && m.content.trim()) parts.push({ text: m.role === 'user' ? shield(m.content) : m.content });
    for (const a of m.attachments || []) {
      parts.push({ inlineData: { mimeType: a.mime, data: a.data } });
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });

  // Thinking tokens bhi maxOutputTokens mein ginte hain; isliye thinkingLevel low rakha hai
  // (varna photo par jawab khali aa sakta hai). Temperature Gemini 3.x mein nahi bhejte.
  const generationConfig = geminiConfig(model, GEMINI_OUTPUT_TOKENS);

  const systemText = sys(messages, opts);
  const calls = [];

  for (let i = 0; i < 5; i++) {
    const r = await post(
      'Gemini(' + model + ')',
      GEMINI_URL(model),
      { 'Content-Type': 'application/json', 'x-goog-api-key': slot.key },
      {
        systemInstruction: { parts: [{ text: systemText }] },
        contents,
        generationConfig,
        tools: GEMINI_TOOLS,
        toolConfig: { functionCallingConfig: { mode: i === 0 && opts.force ? 'ANY' : 'AUTO' } }
      },
      opts.deadline,
      TIMEOUT,
      slot.fast
    );

    const data = await readJson('Gemini', r, opts.deadline);
    const cand = data.candidates?.[0];
    const parts = cand?.content?.parts || [];
    const fcalls = parts.filter(p => p.functionCall);

    if (fcalls.length) {
      // model ke parts jaise hain waise wapas (thought signatures bachi rehti hain)
      contents.push({ role: 'model', parts });
      const responses = fcalls.map(p => {
        const args = p.functionCall.args || {};
        const result = checkedRun(p.functionCall.name, args);
        calls.push({ name: p.functionCall.name, args, result });
        // Gemini 3.x: FunctionResponse ka id/name/count FunctionCall se match hona chahiye
        const fr = { name: p.functionCall.name, response: { result } };
        if (p.functionCall.id) fr.id = p.functionCall.id;
        return { functionResponse: fr };
      });
      contents.push({ role: 'user', parts: responses });
      continue;
    }

    const answer = parts
      .filter(p => !p.thought)
      .map(p => p.text || '')
      .join('')
      .trim();

    if (!answer) {
      const why = data.promptFeedback?.blockReason || cand?.finishReason || 'unknown';
      throw new Error('Gemini(' + model + ') se khali jawab mila (' + why + ')');
    }
    return { text: answer, calls };
  }

  throw new Error('Gemini tool-call limit poora ho gaya');
}

// Pehle main model (saari keys ek ke baad ek), phir fallback model (saari keys)
async function askGemini(messages, opts) {
  const models = [...new Set([process.env.GEMINI_MODEL || 'gemini-3.6-flash', GEMINI_FALLBACK])];

  const errors = [];
  let lastErr;

  for (const model of models) {
    try {
      return await viaKeys(POOLS.gemini, 'Gemini', slot => geminiCall(model, messages, opts, slot));
    } catch (e) {
      eh.logError(e, { where: 'gemini_model', provider: 'gemini', source: 'provider' });
      lastErr = e;
      errors.push(e.message);
    }
  }

  // Aakhri error ka type (timeout/auth/rate limit) bana rehta hai, taaki sahi friendly message bane
  throw Object.assign(new Error(errors.join(' | ')), {
    status: lastErr && lastErr.status,
    headers: lastErr && lastErr.headers,
    code: lastErr && lastErr.code,
    cause: lastErr
  });
}

// media: false = sirf text, 'image' = photo chalegi (PDF nahi), 'all' = photo + PDF
// Order = providers.PRIORITY: Gemini, Groq, baaki, aakhir mein OpenRouter aur OpenAI (paid).
const RUN = { gemini: askGemini, groq: askGroq, openrouter: askOpenRouter, openai: askOpenAI };
const ALL = providers.PRIORITY.map(def => ({
  name: def.name,
  media: def.media,
  run: RUN[def.name] || askCompat(def)
}));

// Key ho aur (OpenAI-compatible ho to) url + model bhi tay ho
const hasKey = p => POOLS[p.name].size() > 0 && providers.configured(p.name);

/* ---------- verified finance info (RBI/tax/schemes) ---------- */

const lookupCache = new Map();
const LOOKUP_TTL = 6 * 3600 * 1000;

// Gemini ki Google Search grounding se jawab laata hai, phir sirf tab "verified"
// maanta hai jab sources mein trusted (official) domain ho. Warna "unverified".
async function verifiedLookup(question, deadline) {
  if (!POOLS.gemini.size()) return { status: 'unavailable' };

  const q = String(question || '').trim().slice(0, 300);
  const cacheKey = q.toLowerCase();
  const cached = lookupCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LOOKUP_TTL) return cached.value;

  try {
    const model = process.env.GEMINI_SEARCH_MODEL || 'gemini-3.6-flash';
    const data = await viaKeys(POOLS.gemini, 'Lookup', async slot => {
      const r = await post(
        'Lookup',
        GEMINI_URL(model),
        { 'Content-Type': 'application/json', 'x-goog-api-key': slot.key },
        {
          systemInstruction: { parts: [{ text: LOOKUP_SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: q }] }],
          tools: [{ google_search: {} }],
          generationConfig: geminiConfig(model, 1000)
        },
        deadline,
        LOOKUP_TIMEOUT,
        slot.fast
      );
      return readJson('Lookup', r, deadline);
    });

    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim().slice(0, 1500);
    const chunks = (cand?.groundingMetadata?.groundingChunks || []).map(c => c.web).filter(Boolean);
    const domains = [...new Set(chunks.map(engine.trustedDomain).filter(Boolean))];

    // Web se aaye text mein niyam badalne wale instructions hon to use verified nahi maante
    const scan = text ? validator.scanInput(text) : null;
    const clean = !(scan && scan.flagged && scan.severity === 'high');

    const value = text && domains.length && clean && !/VERIFY NAHI HUA/i.test(text)
      ? { status: 'verified', text, domains }
      : { status: 'unverified' };

    lookupCache.set(cacheKey, { at: Date.now(), value });
    if (lookupCache.size > 200) lookupCache.delete(lookupCache.keys().next().value);
    return value;
  } catch (e) {
    eh.logError(e, { where: 'lookup', provider: 'gemini', source: 'provider' });
    return { status: 'unavailable' };
  }
}

/* ---------- answer + verification ---------- */

// Reply mein rate/tax/scheme ke aise claims jinka verified source nahi hai (user ke apne diye numbers chhod kar)
function claimProblems(text, verification, userTexts) {
  let vc;
  try {
    vc = validator.verifyClaims(text, verification);
  } catch (_) {
    return [];
  }
  if (!vc || vc.ok) return [];

  const mine = (userTexts || []).join('\n');
  return (vc.claims || [])
    .filter(c => {
      const nums = String(c.snippet || '').match(/\d[\d,]*(?:\.\d+)?/g) || [];
      return !(nums.length && nums.every(n => mine.includes(n)));
    })
    .map(c => c.snippet);
}

// Kaun se calculators is jawab se pehle zaroor chalne chahiye
function expectedTools(env, calcFresh) {
  const set = new Set();
  const { ctx, route } = env;
  if (calcFresh && ctx.complete && ctx.tool) set.add(ctx.tool);
  if (route && !env.hasMedia && route.mode === 'multi' && Array.isArray(route.steps)) {
    route.steps.filter(s => s && s.complete && s.tool).forEach(s => set.add(s.tool));
  }
  return [...set];
}

// Model ka jawab reject hone par: sirf bharosemand cheezein (engine/validator ka result, ya saaf "verify nahi hua")
function fallbackText(env, out, calcFresh, why = {}) {
  const { ctx, verification, route } = env;
  const useCtx = Boolean(ctx && calcFresh);
  const res = (text, verified = false) => ({ text, verified });

  // Model ne galat/guess inputs se tool chalaya: uska result kabhi mat dikhao
  if (useCtx && why.mismatch && !ctx.complete) return res(engine.askForMissing(ctx));

  const fromContext = () => {
    const c = runFromContext(ctx);
    if (!c) return null;
    const used = engine.describeInputs(ctx.inputs);
    return res('Maine ye inputs liye: ' + used + '.\n' + engine.describeResult(c.name, c.args, c.result), okCall(c));
  };

  if (useCtx && ctx.complete && why.mismatch) {
    const r = fromContext();
    if (r) return r;
  }

  const multi = Boolean(route && route.mode === 'multi' && !env.hasMedia);
  if (multi && (why.steps || !out.calls.some(okCall))) {
    const sc = stepCalls(route).filter(okCall);
    if (sc.length) return res(engine.describeCalls(sc) + pendingNote(route), true);
  }

  const okCalls = out.calls.filter(okCall);
  if (okCalls.length) return res(engine.describeCalls(okCalls), true);

  if (useCtx && ctx.complete) {
    const r = fromContext();
    if (r) return r;
  }
  if (useCtx && !ctx.complete) return res(engine.askForMissing(ctx));

  if (verification && verification.status === 'verified') {
    return res('Official source (' + verification.domains.join(', ') + ') se mili jankari:\n' +
      verification.text + '\nPakka karne ke liye official site par ek baar dobara check karein.');
  }
  if (verification || why.claims) return res(UNVERIFIED_REPLY);

  return res('Is jawab ke kuch figures verify nahi ho paye, isliye nahi dikha raha. Apna sawal inputs ke saath dobara poochho.');
}

// Saare AI providers fail hon, par calculation ke inputs poore hon => calculator ka result seedha
function engineOnly(env) {
  if (env.hasMedia) return '';
  const { ctx, route } = env;
  let calls = [];

  if (route && route.mode === 'multi') {
    calls = stepCalls(route);
  } else if (ctx && ctx.fresh && ctx.complete) {
    const c = runFromContext(ctx);
    if (c) calls = [c];
  }

  const ok = calls.filter(okCall);
  if (!ok.length) return '';
  return engine.describeCalls(ok) + pendingNote(route) +
    '\nAI se detail mein samjhana abhi thodi der ke liye available nahi hai, isliye calculator ka verified result dikha raha hoon. Thodi der baad dobara poochho to poori explanation mil jayegi.';
}

function badge(text, calls, userTexts, ctx, verification) {
  try {
    return validator.canShowVerifiedBadge(validator.guardReply(text, calls, userTexts, ctx, { verification }));
  } catch (_) {
    return false;
  }
}

// env.trace (optional) mein monitoring ke liye nateeja bharta hai; return shape nahi badalta
async function answerWith(provider, messages, env) {
  const { ctx, verification } = env;
  const route = env.route;
  const userTexts = messages.filter(m => m.role === 'user').map(m => m.content);
  const calcFresh = Boolean(ctx && ctx.fresh && !env.hasMedia);
  const expected = expectedTools(env, calcFresh);
  // verification block mein "unverified" ho to reply mein koi pakka number nahi aana chahiye
  const extraTexts = verification && verification.status === 'verified' ? [verification.text] : [];
  const base = { verification, hasMedia: env.hasMedia, deadline: env.deadline, route };
  const timeLeft = () => env.deadline - Date.now();
  const goodCalls = o => o.calls.some(okCall);
  const trace = env.trace;

  let out = await provider.run(messages, { ...base });

  // Inputs poore hain par model ne tool nahi chalaya => tool zaroor chalwao
  if (expected.length && !out.calls.length && timeLeft() > MIN_RETRY_TIME) {
    out = await provider.run(messages, { ...base, force: true });
  }

  if (!calcFresh && !out.calls.length && !verification && !expected.length &&
      !claimProblems(out.text, verification, userTexts).length) {
    if (trace) Object.assign(trace, { calls: out.calls, problems: [], verified: false });
    return { text: out.text, checked: false };
  }

  const evaluate = o => {
    const check = engine.verifyReply(o.text, o.calls, userTexts, ctx, extraTexts, { rates: Boolean(verification) });
    const missing = expected.filter(t => !o.calls.some(c => c.name === t && okCall(c)));
    const steps = stepMismatch(route, o.calls);
    const claims = claimProblems(o.text, verification, userTexts);
    return { check, missing, steps, claims, ok: check.ok && !missing.length && !steps.length && !claims.length };
  };

  let ev = evaluate(out);

  if (!ev.ok && timeLeft() > MIN_RETRY_TIME) {
    const parts = [];
    if (!ev.check.ok) {
      const bad = ev.check.unknown.concat(ev.check.mismatch);
      parts.push('Pichhle jawab ke ye numbers calculator, verified source ya user ke inputs se match nahi hue: ' +
        bad.join(', ') + '. Sirf calculator tool ke results, verified jankari ya user ke diye inputs ke numbers use karo; naya number mat banao.');
    }
    if (ev.missing.length) {
      parts.push('Saare inputs maujood hain: ye calculator tool zaroor chalao (' + ev.missing.join(', ') +
        ') aur inputs dobara mat poochho.');
    }
    if (ev.steps.length) {
      parts.push('In tools ke inputs user ke diye inputs se match nahi hue (' + ev.steps.join(', ') +
        '). User ke exact numbers (lakh/crore ka dhyan rakho) se dobara chalao.');
    }
    if (ev.claims.length) {
      parts.push('Rate/tax/scheme ke ye claims verified source se confirm nahi hue: ' + ev.claims.join('; ') +
        '. Inhe hata do ya saaf bolo ki verify nahi hua.');
    }
    out = await provider.run(messages, {
      ...base,
      force: expected.length > 0,
      correction: parts.join(' ')
    });
    ev = evaluate(out);
  }

  const problems = [];
  if (ev.check.unknown.length) problems.push({ code: 'UNPROVEN_FIGURES', field: 'reply' });
  if (ev.check.mismatch.length || ev.steps.length) problems.push({ code: 'CALC_MISMATCH', field: 'tool_inputs' });
  if (ev.missing.length) problems.push({ code: 'MISSING_FIELD', field: 'tool' });
  if (ev.claims.length) problems.push({ code: 'UNVERIFIED_CLAIM', field: 'reply' });

  if (ev.ok) {
    if (trace) {
      Object.assign(trace, {
        calls: out.calls,
        problems,
        verified: goodCalls(out) && badge(out.text, out.calls, userTexts, ctx, verification)
      });
    }
    return { text: out.text, checked: true };
  }

  const fb = fallbackText(env, out, calcFresh, {
    mismatch: ev.check.mismatch.length > 0,
    steps: ev.steps.length > 0,
    claims: ev.claims.length > 0
  });
  if (trace) Object.assign(trace, { calls: out.calls, problems, verified: fb.verified, fallback: true });
  return { text: fb.text, checked: true, fallback: true };
}

/* ---------- rate limit (per instance; bade scale par Upstash/Redis use karo) ---------- */

const hits = new Map();
let globalHits = [];
const PER_MIN = 10;
const PER_HOUR = 60;
const GLOBAL_PER_MIN = 200;

function limited(ip) {
  const now = Date.now();

  globalHits = globalHits.filter(t => now - t < 60000);
  if (globalHits.length >= GLOBAL_PER_MIN) return true;

  const arr = (hits.get(ip) || []).filter(t => now - t < 3600000);
  const lastMinute = arr.filter(t => now - t < 60000).length;

  if (lastMinute >= PER_MIN || arr.length >= PER_HOUR) {
    hits.set(ip, arr);
    return true;
  }

  arr.push(now);
  hits.set(ip, arr);
  globalHits.push(now);

  if (hits.size > 5000) {
    for (const [k, times] of hits) {
      if (!times.length || now - times[times.length - 1] > 3600000) hits.delete(k);
    }
  }

  return false;
}

/* ---------- request cleaning ---------- */

function cleanAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(a =>
      a &&
      MEDIA_TYPES.includes(a.mime) &&
      typeof a.data === 'string' &&
      a.data.length > 0 &&
      a.data.length <= MAX_MEDIA_CHARS &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(a.data)
    )
    .slice(0, MAX_ATTACHMENTS)
    .map(a => ({ mime: a.mime, data: a.data }));
}

// Sirf sahi role/text wale messages; attachments sirf aakhri user message ke.
function sanitize(rawMessages) {
  const incoming = Array.isArray(rawMessages) ? rawMessages.slice(-MAX_MESSAGES) : [];

  const clean = incoming
    .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .map(m => {
      const out = { role: m.role, content: m.content.slice(0, MAX_CONTENT_CHARS) };
      if (m.role === 'user') {
        const attachments = cleanAttachments(m.attachments);
        if (attachments.length) out.attachments = attachments;
      }
      return out;
    })
    .filter(m => m.content.trim() || m.attachments);

  // Conversation hamesha user message se shuru ho
  while (clean.length && clean[0].role === 'assistant') clean.shift();

  const lastIdx = clean.length - 1;
  clean.forEach((m, idx) => {
    if (idx !== lastIdx && m.attachments) {
      delete m.attachments; // purane base64 dobara na bhejo
      if (!m.content.trim()) m.content = OLD_ATTACHMENT_TEXT;
    }
  });

  const last = clean[lastIdx];
  if (last && last.role === 'user' && last.attachments && !last.content.trim()) {
    last.content = DEFAULT_ATTACHMENT_TEXT;
  }

  return clean;
}

/* ---------- router + monitoring + error responses ---------- */

const EMPTY_ROUTE = Object.freeze({
  action: 'general_chat',
  mode: 'general',
  reasons: ['router_error'],
  verification: { required: false },
  steps: [],
  language: {},
  safety: {}
});

// Router kabhi throw nahi karta, par chat ko kisi bhi halat mein nahi rukna chahiye
function safeRoute(messages, opts) {
  try {
    const r = router.route(messages, opts);
    if (r && typeof r === 'object' && r.action) return r;
  } catch (e) {
    eh.logError(e, { where: 'router' });
  }
  return EMPTY_ROUTE;
}

// Roz ki ginti ke naam: sirf category/provider/error ka type; user ka text ya number kabhi nahi
function usageCounters(base, route, errs) {
  const c = { requests: 1, ...base };
  if (route && route.action) c['route.' + route.action] = 1;
  if (route && route.intent) c['intent.' + route.intent] = 1;
  if (route && route.intent && (base.fail || base.fallback)) c['miss.' + route.intent] = 1;
  for (const x of errs || []) {
    const pk = 'provider.' + x.provider + '.fail';
    c[pk] = (c[pk] || 0) + 1;
    const ek = 'error.' + eh.classifyError(x.err).type;
    c[ek] = (c[ek] || 0) + 1;
  }
  return c;
}

// Sirf codes/field names/amount bands log hote hain; user text ya raw numbers nahi
function monitor(env, out, trace) {
  try {
    const problems = trace.problems || [];
    const warnings = [];
    const inj = env.route && env.route.safety && env.route.safety.injection;
    if (inj && inj.flagged) warnings.push({ code: 'INJECTION_SUSPECT', field: 'userText' });
    if (out.fallback) warnings.push({ code: 'REPLY_REPLACED', field: 'reply' });

    const good = (trace.calls || []).filter(okCall).pop();
    validator.safeLog({
      requestId: env.requestId,
      ts: new Date().toISOString(),
      status: problems.length ? 'error' : warnings.length ? 'warning' : 'ok',
      tool: good ? good.name : null,
      checks: { route: env.route ? env.route.action : 'none', badge: trace.verified ? 'ok' : 'skipped' },
      errors: problems,
      warnings
    }, { args: good ? good.args : null, onlyProblems: true });
  } catch (_) { /* monitoring jawab ko kabhi nahi rokta */ }
}

function sendError(res, err, ctx = {}, log = true) {
  const out = eh.toHttpResponse(err, ctx);
  if (log) eh.logError(err, ctx);
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  return res.status(out.status).json(out.body);
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
    (typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'] : '') ||
    req.socket?.remoteAddress ||
    'unknown';
}

function queryParam(req, name) {
  try {
    if (req.query && typeof req.query === 'object') return req.query[name];
    return new URL(req.url || '', 'http://x').searchParams.get(name) ?? undefined;
  } catch (_) {
    return undefined;
  }
}

// ADMIN_TOKEN (kam se kam 16 akshar) se milan; barabar-time compare, kabhi log/response mein nahi.
// Aage-peeche ke space hata diye jaate hain (mobile keyboard aksar space jod deta hai).
function adminCheck(supplied) {
  const expected = String(process.env.ADMIN_TOKEN || '').trim();
  if (!expected) return { ok: false, reason: 'ADMIN_TOKEN server par set nahi hai (variable daalo aur Redeploy karo)' };
  if (expected.length < 16) return { ok: false, reason: 'ADMIN_TOKEN 16 akshar se chhota hai' };
  if (typeof supplied !== 'string' || !supplied.trim()) return { ok: false, reason: 'link mein token khali hai' };
  const h = v => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(h(expected), h(supplied.trim()))
    ? { ok: true }
    : { ok: false, reason: 'token match nahi hua (link ka token aur Vercel ka token alag hain)' };
}

/* ---------- streaming reply (verify hone ke baad tukdon mein) ---------- */

const wantsStream = req => /text\/event-stream/i.test(String((req.headers && req.headers.accept) || ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Jawab pehle poora verify ho chuka hota hai; yahan sirf use tukdon mein bheja jaata hai.
// Browser ne event-stream nahi maanga (ya reply khali hai) to normal JSON, jaise pehle.
// Aakhri "done" event mein poora payload (reply, verified, options, requestId ...) dobara jaata hai.
async function respondOk(req, res, payload) {
  if (!wantsStream(req) || typeof payload.reply !== 'string' || !payload.reply) {
    return res.status(200).json(payload);
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  const text = payload.reply;
  const size = Math.max(10, Math.ceil(text.length / 70));

  try {
    for (let i = 0; i < text.length; i += size) {
      if (res.destroyed || res.writableEnded) return;
      res.write('data: ' + JSON.stringify({ delta: text.slice(i, i + size) }) + '\n\n');
      await sleep(14);
    }
    res.write('data: ' + JSON.stringify({ done: true, ...payload }) + '\n\n');
  } catch (_) { /* client beech mein chala gaya */ }

  try { res.end(); } catch (_) {}
}

/* ---------- handler ---------- */

async function handler(req, res, meta) {
  const requestId = (meta && meta.requestId) || eh.requestIdFrom(req);
  res.setHeader('Cache-Control', 'no-store');

  // Internal error details sirf tab, jab Vercel env mein DEBUG_ERRORS=1 set ho (temporary).
  const debug = process.env.DEBUG_ERRORS === '1';

  if (req.method === 'GET') {
    // Secret test link: /api/chat?alert_test=<ADMIN_TOKEN> => test email bhejta hai. Galat/bina token par normal health jawab.
    let testNote;
    const supplied = queryParam(req, 'alert_test');
    if (supplied !== undefined) {
      if (limited(clientIp(req))) {
        return sendError(res, new eh.AppError({
          type: eh.ERROR_TYPES.RATE_LIMIT, scope: 'user', retryAfterMs: 60000, code: 'RATE_LIMITED', message: 'ip rate limit'
        }), { requestId, where: 'chat', scope: 'user' }, false);
      }
      const chk = adminCheck(supplied);
      if (chk.ok) {
        const r = await alerts.sendAlert('info', 'Test alert: Gmail alert sahi chal raha hai',
          { requestId, note: 'Ye sirf test email hai' }, { force: true, timeoutMs: 8000 });
        return res.status(200).json({
          ok: true,
          alert: { configured: alerts.isConfigured(), sent: r.sent, reason: r.reason, detail: r.detail }
        });
      }
      testNote = chk.reason;
    }
    const health = { ok: true };
    // Sirf DEBUG_ERRORS=1 mein: test link kyun kaam nahi kiya (token ya value nahi dikhti)
    if (debug && testNote) health.alert_test = testNote;
    // Debug mein sirf keys ki ginti dikhti hai (kaun si key kitni, cooldown mein kitni); keys kabhi nahi
    if (debug) {
      health.keys = Object.fromEntries(Object.entries(POOLS).map(([k, p]) => [k, p.summary()]));
      health.alerts = { configured: alerts.isConfigured() };
    }
    return res.status(200).json(health);
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ message: 'Sirf GET aur POST allowed hain.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body && typeof body === 'object' ? body : {};

  let requestBytes;
  try {
    requestBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch (_) {
    requestBytes = MAX_REQUEST_CHARS + 1;
  }

  if (requestBytes > MAX_REQUEST_CHARS) {
    return res.status(413).json({
      message: 'Request bahut badi hai. Chhota message ya file bhejo.',
      requestId
    });
  }

  if (limited(clientIp(req))) {
    return sendError(res, new eh.AppError({
      type: eh.ERROR_TYPES.RATE_LIMIT,
      scope: 'user',
      retryAfterMs: 60000,
      code: 'RATE_LIMITED',
      message: 'ip rate limit'
    }), { requestId, where: 'chat', scope: 'user' }, false);
  }

  const messages = sanitize(body.messages);
  const last = messages[messages.length - 1];

  if (!last || last.role !== 'user') {
    return res.status(400).json({ message: 'Pehle apna sawal likho.', requestId });
  }

  const attachments = last.attachments || [];
  const mediaChars = attachments.reduce((n, a) => n + a.data.length, 0);
  if (mediaChars > MAX_MEDIA_CHARS) {
    return res.status(413).json({ message: 'Files bahut badi hain. Chhoti file ya kam photos bhejo.', requestId });
  }

  const hasMedia = attachments.length > 0;
  const hasPdf = attachments.some(a => a.mime === 'application/pdf');

  // 1) Router: kya karna hai
  const route = safeRoute(messages, { hasMedia });
  if (debug) {
    console.info(JSON.stringify({
      event: 'route', requestId, action: route.action, intent: route.intent, tool: route.tool,
      reasons: route.reasons, lang: route.language && route.language.code
    }));
  }

  // 2) Blocked / upload chahiye / clarification: LLM ki zaroorat nahi (providers na hon tab bhi chalta hai)
  if (DIRECT_ACTIONS.has(route.action)) {
    const direct = router.directReply(route);
    if (direct) {
      const payload = { reply: direct, checked: false, verified: false, source: 'router', action: route.action, requestId };
      const options = route.clarification && route.clarification.options;
      if (Array.isArray(options) && options.length) payload.options = options;
      await stats.record(usageCounters({ ok: 1 }, route));
      return respondOk(req, res, payload);
    }
  }

  // 2b) Aam concept sawal ("EMI kya hai?"): tayyar jawab, AI/API ka quota nahi lagta (keys na hon tab bhi chalta hai)
  if (!hasMedia) {
    const kb = knowledge.lookup(route, last.content);
    if (kb) {
      await stats.record(usageCounters({ ok: 1, kb_hit: 1 }, route));
      return respondOk(req, res, {
        reply: kb.reply, checked: false, verified: false, source: 'knowledge', topic: kb.topic,
        options: kb.options, requestId
      });
    }
  }

  // 2c) Admin ki glossary: sirf aam (general) sawal par, rate/calculator wale sawal ko nahi chhuta
  if (!hasMedia && ['general_chat', 'answer_concept'].includes(route.action)) {
    const g = await glossary.lookup(last.content);
    if (g) {
      await stats.record(usageCounters({ ok: 1, glossary_hit: 1 }, route));
      return respondOk(req, res, {
        reply: g.text, checked: false, verified: false, source: 'glossary', topic: g.term, requestId
      });
    }
  }

  const configured = ALL.filter(hasKey);
  const eligible = configured.filter(p =>
    !hasMedia || p.media === 'all' || (p.media === 'image' && !hasPdf)
  );

  if (!eligible.length) {
    if (!configured.length) {
      eh.logError(new eh.AppError({
        type: eh.ERROR_TYPES.AUTH, message: 'no provider api key configured', code: 'NO_PROVIDER'
      }), { requestId, where: 'providers' }, { debug });
      await alerts.sendAlert('urgent', 'Koi AI API key set nahi hai', { requestId }, { timeoutMs: 3000 });
    }
    const msg = configured.length && hasMedia
      ? 'Abhi ye file type process nahi ho sakta. Photo ya text bhejo.'
      : 'Assistant abhi available nahi hai. Thodi der baad try karo.';
    await stats.record(usageCounters({ fail: 1, 'error.no_provider': 1 }, route));
    return res.status(503).json({ message: msg, requestId });
  }

  const deadline = Date.now() + TOTAL_BUDGET;

  let ctx = null;
  try {
    ctx = engine.buildContext(messages);
  } catch (e) {
    eh.logError(e, { requestId, where: 'finance_context' }, { debug });
  }

  // 3) Official facts (rate/tax/scheme) chahiye to verified lookup
  const routerFailed = (route.reasons || []).includes('router_error');
  const needsLookup = routerFailed
    ? Boolean(ctx && ctx.needsVerification)
    : Boolean(route.verification && route.verification.required);

  let verification;
  if (!hasMedia && needsLookup) {
    const query = (route.verification && route.verification.query) || last.content;
    verification = await verifiedLookup(query, deadline);
  }

  // 4) Providers (fallback order mein)
  const env = { ctx, verification, hasMedia, deadline, route, requestId };
  const errs = [];

  const open = new Set(eligible.filter(p => breaker.isOpen(p.name)).map(p => p.name));
  const live = eligible.filter(p => !open.has(p.name));
  // Sawal ke type (media/facts/calc/chat/long) ke hisaab se provider ka order (lib/provider-router.js)
  const routed = providerRouter.order(live.length ? live : eligible, { route, hasMedia, text: last.content, pools: POOLS });
  const tryList = routed.list; // sab band hon to bhi aakhri koshish

  for (const provider of tryList) {
    if (deadline - Date.now() < 3000) break;
    const started = Date.now();
    const trace = {};

    try {
      const run = () => answerWith(provider, messages, { ...env, trace });
      const out = open.has(provider.name) ? await run() : await breaker.exec(provider.name, run);
      monitor(env, out, trace);
      await stats.record(usageCounters(
        { ok: 1, ['provider.' + provider.name + '.ok']: 1, ['pick.' + routed.category]: 1, ...(out.fallback ? { fallback: 1 } : {}) }, route, errs));

      const payload = {
        reply: out.text,
        checked: Boolean(out.checked),
        verified: Boolean(trace.verified),
        requestId
      };
      if (out.fallback) payload.fallback = true;
      return await respondOk(req, res, payload);
    } catch (e) {
      eh.logError(e, {
        requestId, where: 'answer', provider: provider.name, durationMs: Date.now() - started, source: 'provider'
      }, { debug });
      errs.push({ provider: provider.name, err: e });
    }
  }

  // 5) AI nahi chala, par calculation ke inputs poore hain => calculator ka result seedha
  try {
    const local = engineOnly(env);
    if (local) {
      monitor(env, { fallback: true }, { calls: [], problems: [], verified: true });
      await stats.record(usageCounters({ ok: 1, engine_only: 1 }, route, errs));
      await alerts.sendAlert('warning', 'AI nahi chala, calculator ka result diya', {
        requestId, providers: errs.map(x => x.provider).join(', ') || 'koi nahi'
      }, { timeoutMs: 3000 });
      return await respondOk(req, res, {
        reply: local, checked: true, verified: true, fallback: true, source: 'engine', requestId
      });
    }
  } catch (e) {
    eh.logError(e, { requestId, where: 'engine_only' }, { debug });
  }

  // 6) Friendly error (raw error/stack/key kabhi user ko nahi dikhta)
  const lastErr = errs.length
    ? errs[errs.length - 1].err
    : new eh.AppError({ type: eh.ERROR_TYPES.TIMEOUT, message: 'time budget khatam', code: 'TIME_BUDGET' });

  const lastInfo = eh.classifyError(lastErr);
  await stats.record(usageCounters({ fail: 1 }, route, errs), {
    type: lastInfo.type, code: lastInfo.code || '', provider: errs.map(x => x.provider).join(',')
  });
  await alerts.sendAlert('urgent', 'Saare AI providers fail ho gaye', {
    requestId,
    providers: errs.map(x => x.provider).join(', ') || 'koi nahi',
    errorType: lastInfo.type,
    code: lastInfo.code || ''
  }, { timeoutMs: 3000 });

  const out = eh.toHttpResponse(lastErr, { requestId, where: 'providers', scope: 'provider', source: 'provider' });
  if (debug) {
    out.body.debug = errs.map(x =>
      x.provider + ': ' + eh.sanitize(x.err && x.err.message ? x.err.message : String(x.err), { maxLen: 300 }));
  }
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  return res.status(out.status).json(out.body);
}

// wrapHandler: request id + koi bhi unexpected throw => sanitized JSON error + structured log
module.exports = eh.wrapHandler(handler, {
  where: 'chat',
  get debug() { return process.env.DEBUG_ERRORS === '1'; }
});

module.exports.__test = {
  handler, post, answerWith, limited, sanitize, sys, verifiedLookup,
  checkedRun, shield, fallbackText, engineOnly, stepMismatch, claimProblems, breaker, POOLS,
  respondOk, wantsStream
};
