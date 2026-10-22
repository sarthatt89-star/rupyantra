'use strict';

/*
 * Admin AI ki "poori website ki knowledge" (lib/admin-knowledge.js)
 * Jab bhi koi nayi file, env ya badlaav ho, yahan CHANGELOG aur KNOWN_ISSUES update karo; AI turant jaan jayega.
 * Isme koi key/password/token nahi likhna.
 */

const ARCHITECTURE = [
  'WEBSITE: Vercel par. Pages: /ai (index.html, public chat), /admin (admin.html). Backend: api/ folder ke serverless functions, lib/ mein logic.',
  'PUBLIC CHAT FLOW (api/chat.js): rate limit -> router (lib/intent-router) -> blocked/clarification ho to seedha jawab -> knowledge-base (tayyar jawab) -> glossary (admin ki entries) -> verified lookup (rate/tax ke liye Gemini search, sirf official domains) -> providers: Gemini, Groq, OpenRouter, OpenAI (is order mein, circuit breaker ke saath) -> reply ke numbers verify (engine + validator) -> fail ho to calculator ka fallback.',
  'CALCULATORS: lib/finance-engine.js (EMI, SIP, FD, CAGR, simple interest, GST, inflation, budget, compare). lib/finance-validator.js independent cross-check karta hai.',
  'KEYS: lib/key-pool.js. Har provider ki kai keys (BASE, BASE_1..10, BASES list). 429/401/402 par agli key, cooldown memory mein. Timeout/5xx par key nahi badalti.',
  'ALERTS: lib/alert.js Gmail se email (throttle: urgent 30 min, warning 60 min, ghante mein max 10). Mail se commands: api/mail-ask.js + Apps Script (PIN + sender verify).',
  'STATS: lib/stats.js Upstash Redis mein roz ki ginti (sirf counters, user text kabhi nahi). Upstash na ho to ginti band, site chalti rehti hai.',
  'SMART ROUTING (lib/provider-router.js): sawal ka type (media, facts, calc, chat, long) dekh kar tay hota hai kaun sa provider pehle. Chat/concept: Groq, Cerebras, SambaNova pehle. Calculator: Gemini, Groq pehle. Facts (rate/tax): Gemini pehle. Photo/PDF: Gemini, OpenAI, OpenRouter. Jiski saari keys cooldown mein hon wo peeche. Override: Vercel env AI_ROUTING (jaise calc=groq,gemini; chat=cerebras).',
  'PROVIDERS (lib/providers.js): koi bhi key apne aap pehchani jaati hai (naam KEY/KEYS par khatam, ya AI_KEYS). Gemini, Groq, OpenRouter, OpenAI, SambaNova, Cerebras, Mistral, DeepSeek, Together, xAI, custom.',
  'ADMIN: login OTP email se (lib/admin-auth.js), session cookie rp_admin (HttpOnly, Secure, Strict, 8 ghante). APIs: /api/admin/auth, status, chat, glossary, report. Sab sirf login ke baad.',
  'ADMIN AI (lib/admin-chat.js): Gemini phir Groq. Sirf report data + ye knowledge dekhta hai. Koi badlaav khud nahi karta.',
  'VERCEL ENV (naam hi, value kabhi nahi): AI keys (4 providers), ADMIN_SESSION_SECRET (24+), ADMIN_EMAIL, SITE_URL, GMAIL_USER, GMAIL_APP_PASSWORD, ALERT_TO, UPSTASH_REDIS_REST_URL/TOKEN, MAIL_ASK_SECRET/PIN/ALLOWED, ADMIN_TOKEN, DEBUG_ERRORS (sirf debug ke liye, normal mein band).',
  'LIMITS: chat maxDuration 60s (TOTAL_BUDGET 45s), mail-ask 30s, admin/auth 15s. Rate limit per-instance memory mein hai.',
].join('\n');

const CHANGELOG = [
  'Smart routing: sawal ke type ke hisaab se AI provider chunna (provider-router).',
  'Providers: koi bhi API key auto-detect (providers.js), admin chat bhi kisi bhi provider se.',
  'Admin panel: OTP login, status report, glossary, sawal report, admin AI chat jode gaye.',
  'Key pool: kai API keys, cooldown aur Gmail alert.',
  'Gemini 3.x config (thinkingLevel low), fallback model gemini-3.5-flash-lite.',
  'Knowledge base + glossary: aam sawalon par bina AI quota ke jawab.',
  'Mail-ask: Gmail se PIN-protected commands (status, keys, aaj, errors, summary).',
].join('\n- ');

const KNOWN_ISSUES = [
  'OTP attempts GET->SET se ginte hain: parallel requests se 5 ki limit bypass ho sakti hai (atomic INCR chahiye).',
  'Admin lock global hai: koi bhi galat codes bhej kar admin ko 15 min lock kar sakta hai.',
  'Mail-bombing: request action se ghante mein 5 OTP email ja sakte hain.',
  'Rate limits (chat aur admin auth) per-instance memory mein hain, isliye loose hain.',
  'alert_test=<ADMIN_TOKEN> URL mein token jaata hai (logs/history mein reh sakta hai).',
  'vercel.json mein api/admin/chat.js aur status.js par maxDuration nahi hai.',
  'Public chat: text file ka content IndexedDB mein save hota hai; stop dabane par user turn bina jawab ke rehta hai.',
  'index.html canonical domain live domain se match karna chahiye.',
].map(x => '- ' + x).join('\n');

const KNOWLEDGE = [
  'WEBSITE ARCHITECTURE:', ARCHITECTURE,
  '', 'HAAL KE BADLAAV (CHANGELOG):', '- ' + CHANGELOG,
  '', 'JANE-PEHCHANE ISSUES (code review se):', KNOWN_ISSUES,
].join('\n');

module.exports = { KNOWLEDGE, ARCHITECTURE, CHANGELOG, KNOWN_ISSUES };
