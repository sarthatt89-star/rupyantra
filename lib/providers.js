'use strict';

/*
 * Rupeyantra AI Providers (lib/providers.js)
 *
 * Kaam: kisi bhi AI provider ki key chale. Keys do tareeke se aati hain:
 *  1) Provider ke apne naam se (GEMINI_API_KEY, GROQ_API_KEY_2, SAMBANOVA_API_KEYS=k1,k2 ...)
 *  2) Ek hi env AI_KEYS mein, comma / space / nayi line se alag. Har key ka provider khud pehchana jaata hai:
 *       AIza...  = Gemini       gsk_... = Groq        sk-or-... = OpenRouter
 *       csk-...  = Cerebras     xai-... = xAI         xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (UUID) = SambaNova
 *       sk-...   = OpenAI
 *     Jiska prefix pehchan mein na aaye (DeepSeek, Mistral, Together...), usse naam ke saath likho:
 *       AI_KEYS = deepseek:sk-abc..., mistral:xyz..., AIza...
 *  3) Ya koi bhi env variable (naam kuch bhi, bas KEY/KEYS par khatam ho) mein key daalo: prefix se apne aap pehchani jaati hai.
 *  4) Koi bhi OpenAI-compatible service: CUSTOM_AI_URL (poora .../chat/completions), CUSTOM_AI_MODEL, CUSTOM_AI_KEY
 * Model badalne ke liye <NAAM>_MODEL (jaise SAMBANOVA_MODEL). Bina model ke koi provider nahi chalta.
 * Keys kabhi log ya response mein nahi jaati.
 */

const keyPool = require('./key-pool');

const U = (host, path) => 'https://' + host + path;

const DEFS = [
  { name: 'gemini', label: 'Gemini', kind: 'gemini', base: 'GEMINI_API_KEY', media: 'all', prefix: /^AIza/ },
  { name: 'groq', label: 'Groq', kind: 'openai', base: 'GROQ_API_KEY', media: false, prefix: /^gsk_/,
    url: U('api.groq.com', '/openai/v1/chat/completions'), model: 'openai/gpt-oss-120b' },
  { name: 'openrouter', label: 'OpenRouter', kind: 'openai', base: 'OPENROUTER_API_KEY', media: 'image', prefix: /^sk-or-/,
    url: U('openrouter.ai', '/api/v1/chat/completions'), model: 'meta-llama/llama-3.3-70b-instruct' },
  { name: 'openai', label: 'OpenAI', kind: 'openai', base: 'OPENAI_API_KEY', media: 'all', prefix: /^sk-(?!or-|ant-)/,
    url: U('api.openai.com', '/v1/chat/completions'), model: 'gpt-4o-mini' },
  { name: 'sambanova', label: 'SambaNova', kind: 'openai', base: 'SAMBANOVA_API_KEY', media: false,
    prefix: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    url: U('api.sambanova.ai', '/v1/chat/completions'), model: 'Meta-Llama-3.3-70B-Instruct' },
  { name: 'cerebras', label: 'Cerebras', kind: 'openai', base: 'CEREBRAS_API_KEY', media: false, prefix: /^csk-/,
    url: U('api.cerebras.ai', '/v1/chat/completions'), model: 'llama-3.3-70b' },
  { name: 'mistral', label: 'Mistral', kind: 'openai', base: 'MISTRAL_API_KEY', media: false,
    url: U('api.mistral.ai', '/v1/chat/completions'), model: 'mistral-small-latest' },
  { name: 'deepseek', label: 'DeepSeek', kind: 'openai', base: 'DEEPSEEK_API_KEY', media: false,
    url: U('api.deepseek.com', '/chat/completions'), model: 'deepseek-chat' },
  { name: 'together', label: 'Together', kind: 'openai', base: 'TOGETHER_API_KEY', media: false,
    url: U('api.together.xyz', '/v1/chat/completions'), model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  // xAI ka model env se do: XAI_MODEL
  { name: 'xai', label: 'xAI', kind: 'openai', base: 'XAI_API_KEY', media: false, prefix: /^xai-/,
    url: U('api.x.ai', '/v1/chat/completions'), model: '' },
  { name: 'custom', label: 'Custom', kind: 'openai', base: 'CUSTOM_AI_KEY', media: false, url: '', model: '' },
];

// Dikhane ka order (admin panel, mail commands)
const NAMES = DEFS.map(d => d.name);

// Kaun pehle try ho: Gemini, Groq, baaki free/sasta, aakhir mein OpenRouter aur OpenAI (paid)
const ORDER = ['gemini', 'groq', 'sambanova', 'cerebras', 'mistral', 'deepseek', 'together', 'xai', 'custom', 'openrouter', 'openai'];
const PRIORITY = ORDER.map(n => DEFS.find(d => d.name === n));

const byName = name => DEFS.find(d => d.name === String(name).toLowerCase()) || null;

/* ---------- AI_KEYS padhna ---------- */

function detect(key) {
  for (const d of DEFS) if (d.prefix && d.prefix.test(key)) return d.name;
  return null;
}

// [{ provider, key }] aur jo pehchane nahi gaye unki ginti (key kabhi nahi)
function parseAiKeys(env = process.env) {
  const out = [];
  let unknown = 0;
  for (const tok of String(env.AI_KEYS || '').split(/[\s,;]+/).map(t => t.trim()).filter(Boolean)) {
    const m = tok.match(/^([A-Za-z0-9_-]+):(.+)$/);
    if (m && byName(m[1])) { out.push({ provider: byName(m[1]).name, key: m[2] }); continue; }
    const p = detect(tok);
    if (p) out.push({ provider: p, key: tok }); else unknown++;
  }
  return { keys: out, unknown };
}

// Koi bhi env variable (naam kuch bhi ho, bas naam mein KEY/KEYS ho) jisme pehchani jaane wali key ho, apne aap lag jaati hai.
// Ye env bahar rakhe jaate hain: unka AI se koi lena-dena nahi.
const SKIP_ENV = /^(UPSTASH_|ADMIN_|MAIL_ASK_|GMAIL_|ALERT_|SITE_URL|VERCEL|NEXT_|AI_KEYS$)/i;
// Jis env ka naam kisi provider ke naam se shuru ho (DEEPSEEK_API_KEY, SAMBANOVA_KEY ...) uski key usi provider ki maani jaati hai.
// Prefix se dobara pehchaan nahi hoti: DeepSeek ki key bhi 'sk-' se shuru hoti hai aur galti se OpenAI ban jaati.
const OWN_ENV = new RegExp('^(' + DEFS.map(d => d.name).join('|') + ')_', 'i');

function scanEnv(env = process.env) {
  const out = [];
  for (const [name, val] of Object.entries(env)) {
    if (!/KEYS?$/i.test(name) || SKIP_ENV.test(name) || typeof val !== 'string') continue;
    const own = name.match(OWN_ENV);
    for (const tok of val.split(/[\s,;]+/).map(t => t.trim().replace(/^["']+|["']+$/g, '')).filter(Boolean)) {
      if (own) { out.push({ provider: own[1].toLowerCase(), key: tok }); continue; } // naam se hi provider tay
      const p = detect(tok);
      // UUID jaisi key sirf tab, jab env ke naam mein SAMBA ho (warna koi aur id ho sakti hai)
      if (p && (p !== 'sambanova' || /SAMBA/i.test(name))) out.push({ provider: p, key: tok });
    }
  }
  return out;
}

const extraKeys = (name, env = process.env) =>
  [...parseAiKeys(env).keys, ...scanEnv(env)].filter(k => k.provider === name).map(k => k.key);

/* ---------- url / model ---------- */

const modelOf = (d, env = process.env) =>
  String(env[d.name === 'custom' ? 'CUSTOM_AI_MODEL' : d.name.toUpperCase() + '_MODEL'] || d.model || '').trim();
const urlOf = (d, env = process.env) => (d.name === 'custom' ? String(env.CUSTOM_AI_URL || '').trim() : d.url);

// Provider tabhi chalega jab OpenAI-compatible hone par url aur model dono hon
function configured(name, env = process.env) {
  const d = byName(name);
  if (!d) return false;
  if (d.kind === 'gemini') return true;
  const url = urlOf(d, env);
  return /^https:\/\//i.test(url) && Boolean(modelOf(d, env));
}

// Har provider ka key pool (apne env + AI_KEYS dono se keys)
function makePools(env = process.env) {
  const pools = {};
  for (const d of DEFS) pools[d.name] = keyPool.createKeyPool(d.base, { env, extraKeys: () => extraKeys(d.name, env) });
  return pools;
}

module.exports = { scanEnv, DEFS, NAMES, PRIORITY, byName, detect, parseAiKeys, extraKeys, modelOf, urlOf, configured, makePools };
