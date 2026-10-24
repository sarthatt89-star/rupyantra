'use strict';

/*
 * Rupeyantra AI - Error Handler (lib/error-handler.js)
 *
 * Koi external dependency nahi (sirf Node ka built-in `crypto`).
 *
 * Hisse:
 *  1. Types, severity, AppError
 *  2. Sensitive data protection ........ sanitize()
 *  3. Error detection .................. classifyError(), extractRetryAfterMs()
 *  4. Friendly messages ................ friendlyMessage()
 *  5. Timeout / retry / circuit breaker  withTimeout(), retry(), createCircuitBreaker()
 *  6. Calculation protection ........... checkFinancialResult(), guardToolResult()
 *  7. Reports + logging ................ logError()
 *  8. HTTP response + handler wrapper .. toHttpResponse(), wrapHandler()
 *
 * Rule: user ko kabhi raw error, stack, API key ya provider ka response nahi dikhta.
 * Sab kuch sanitize hota hai; request ID se hi baad mein logs mein dhoondhiye.
 * Tests: tests/error-handler.test.js
 */

const crypto = require('node:crypto');

/* ========================================================================== */
/* 1. Types, severity, AppError                                               */
/* ========================================================================== */

const ERROR_TYPES = Object.freeze({
  VALIDATION: 'validation',
  RATE_LIMIT: 'rate_limit',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  SERVER: 'server',
  API: 'api',
  AUTH: 'auth',
  CODE: 'code',
  CALCULATION: 'calculation',
  UNKNOWN: 'unknown'
});

const SEVERITY = Object.freeze({
  MINOR: 'minor',
  WARNING: 'warning',
  CRITICAL: 'critical'
});

// status = user ko bheja jaane wala HTTP status (provider ka asli status nahi)
const TYPE_DEFAULTS = Object.freeze({
  validation: { severity: 'minor', status: 400, retryable: false },
  rate_limit: { severity: 'warning', status: 429, retryable: true },
  timeout: { severity: 'warning', status: 504, retryable: true },
  network: { severity: 'warning', status: 502, retryable: true },
  server: { severity: 'warning', status: 503, retryable: true },
  api: { severity: 'warning', status: 502, retryable: false },
  auth: { severity: 'critical', status: 503, retryable: false },
  code: { severity: 'critical', status: 500, retryable: false },
  calculation: { severity: 'critical', status: 500, retryable: false },
  unknown: { severity: 'warning', status: 500, retryable: false }
});

const MAX_RETRY_AFTER_MS = 3600000; // 1 ghanta
const DEFAULT_RATE_LIMIT_WAIT = Object.freeze({ user: 60, provider: 30 }); // seconds

class AppError extends Error {
  constructor(opts = {}) {
    super(typeof opts.message === 'string' && opts.message ? opts.message : 'Error');
    this.name = 'AppError';
    this.type = opts.type || ERROR_TYPES.UNKNOWN;
    this.status = opts.status;
    this.severity = opts.severity;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
    this.scope = opts.scope; // rate_limit: 'user' ya 'provider'
    this.code = opts.code;
    this.details = opts.details; // validation: [{field, message}]
    if (opts.cause) this.cause = opts.cause; // sirf internal; kabhi response mein nahi jaata
  }
}

const shouldAlert = severity => severity === SEVERITY.CRITICAL;
const clampInt = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Math.floor(Number(n)) : lo));

/* ========================================================================== */
/* 2. Sensitive data protection                                               */
/* ========================================================================== */

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)/i;

const escapeRegExp = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Environment mein jo secrets set hain (API keys etc.) unki exact value
function envSecretValues() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_NAME.test(k) && typeof v === 'string') {
      // GEMINI_API_KEYS / AI_KEYS jaisi list wali env ko alag-alag keys mein todo ("naam:key" ke dono hisse bhi)
      for (const part of v.split(/[\s,;:]+/)) {
        if (part.trim().length >= 8) out.push(part.trim());
      }
    }
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

const PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [
    /\b(authorization|x-api-key|x-goog-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd|pwd|token)(["']?\s*[:=]\s*["']?)([^\s"',;&}]{3,})/gi,
    (m, k, sep) => k + sep + '[REDACTED]'
  ],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[JWT]'],
  [
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,})/g,
    '[API_KEY]'
  ],
  [/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+\/=]{20,}/gi, '[DATA]'],
  [/[A-Za-z0-9+\/]{200,}={0,2}/g, '[DATA]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]'],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[PAN]'],
  [/\b(otp|cvv|cvc|pin)\b(\s*(?:is|=|:|hai)?\s*)\d{3,8}\b/gi, (m, k, sep) => k + sep + '[REDACTED]'],
  [/(?<![\d,.])\d{4}[ -]\d{4}[ -]\d{4}(?!\d)/g, '[ID]']
];

const CARD_RE = /(?<![\d₹.,])(?:\d[ -]?){12,18}\d(?![\d,.])/g;
const PHONE_RE = /(?<![\d₹.,])(?:\+?91[\s-]?)?[6-9]\d{9}(?![\d,.])/g;

function safeToString(v) {
  try {
    if (v instanceof Error) return v.message || String(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  } catch (_) {
    return '[unprintable]';
  }
}

// Kisi bhi text se secrets/private details hata deta hai. Amounts (50,00,000) ko nahi chhedta.
function sanitize(input, opts = {}) {
  const maxLen = Number.isInteger(opts.maxLen) ? opts.maxLen : 500;
  if (input === null || input === undefined) return '';
  let s = typeof input === 'string' ? input : safeToString(input);

  for (const secret of envSecretValues()) {
    s = s.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  s = s.replace(CARD_RE, m => {
    const digits = m.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[CARD]' : m;
  });
  s = s.replace(PHONE_RE, '[PHONE]');

  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

/* ========================================================================== */
/* 3. Error detection                                                         */
/* ========================================================================== */

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH',
  'EHOSTUNREACH', 'ENETDOWN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT'
]);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ERR_TIMEOUT'
]);

const AUTH_MESSAGE = /(?:invalid|incorrect|missing|expired|revoked|bad|wrong)\s+(?:api[\s_-]?key|token|credentials?|authori[sz]ation)|api[\s_-]?key\s+(?:not\s+valid|missing|invalid|expired)|unauthori[sz]ed|forbidden|permission[_\s]denied|authentication|not\s+authenticated/i;
const RATE_MESSAGE = /rate[\s-]?limit|too many requests|quota|resource[_\s]exhausted|requests? per (?:minute|day|second)/i;
const QUOTA_HARD = /quota|billing|daily|per day|exceeded your current/i;
const TIMEOUT_MESSAGE = /time(?:d)?[\s-]?out|deadline exceeded|time budget/i;
const NETWORK_MESSAGE = /fetch failed|network error|network request failed|socket hang up|connection (?:reset|refused|closed|lost)|unreachable|getaddrinfo|\bECONN\w*|\bENOTFOUND\b|\bEAI_AGAIN\b|offline/i;
const CALC_MESSAGE = /\bNaN\b|\bInfinity\b|divi(?:de|sion) by zero|calculate nahi|calculation (?:error|nahi)|result bharosemand/i;
const VALIDATION_MESSAGE = /missing hai|galat hai|allowed range|dena zaroori|nahi ho sakta|invalid input|validation|must be (?:a )?(?:positive|number)|payload too large|request entity too large/i;

function toErrorLike(input) {
  if (input instanceof Error) return input;
  if (typeof input === 'string') return new Error(input);
  if (input && typeof input === 'object') {
    const e = new Error(typeof input.message === 'string' ? input.message : 'Unknown error');
    for (const k of ['name', 'code', 'status', 'statusCode', 'headers', 'response', 'retryAfterMs', 'retryAfter', 'cause', 'details']) {
      if (input[k] !== undefined) {
        try { e[k] = input[k]; } catch (_) { /* read-only */ }
      }
    }
    return e;
  }
  return new Error(input === undefined || input === null ? 'Unknown error' : String(input));
}

function causeChain(err) {
  const chain = [];
  let cur = err;
  for (let i = 0; cur && typeof cur === 'object' && i < 5; i++) {
    chain.push(cur);
    if (Array.isArray(cur.errors)) cur.errors.slice(0, 3).forEach(x => x && typeof x === 'object' && chain.push(x));
    cur = cur.cause;
  }
  return chain;
}

const codesOf = err => causeChain(err).map(e => (typeof e.code === 'string' ? e.code : null)).filter(Boolean);

function statusOf(err) {
  for (const e of causeChain(err)) {
    for (const c of [e.status, e.statusCode, e.response && e.response.status]) {
      const n = Number(c);
      if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
    }
  }
  const msg = String(err.message || '');
  const m = msg.match(/\bHTTP\s+(\d{3})\b/i) || msg.match(/\bstatus(?:\s+code)?[:\s]+(\d{3})\b/i);
  return m ? Number(m[1]) : null;
}

/* ---------- retry-after (rate-limit delay) ---------- */

const UNIT_MS = { ms: 1, millisecond: 1, milliseconds: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000 };

function unitToMs(num, unit) {
  const f = unit ? UNIT_MS[String(unit).toLowerCase()] : 1000;
  return Math.round(parseFloat(num) * (f || 1000));
}

function headerGet(h, name) {
  if (!h) return null;
  if (typeof h.get === 'function') {
    try { return h.get(name); } catch (_) { return null; }
  }
  if (typeof h === 'object') {
    const k = Object.keys(h).find(x => x.toLowerCase() === name);
    return k ? h[k] : null;
  }
  return null;
}

// Retry-After header: seconds ("12") ya HTTP date. Milliseconds mein, ya null.
function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.min(MAX_RETRY_AFTER_MS, Math.round(parseFloat(s) * 1000));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, t - now));
}

function extractRetryAfterMs(input) {
  const err = toErrorLike(input);
  const cap = n => (Number.isFinite(n) && n >= 0 ? Math.min(MAX_RETRY_AFTER_MS, Math.round(n)) : null);

  for (const e of causeChain(err)) {
    if (typeof e.retryAfterMs === 'number') return cap(e.retryAfterMs);
    if (e.retryAfter !== undefined && e.retryAfter !== null) {
      const ms = parseRetryAfter(e.retryAfter);
      if (ms !== null) return ms;
    }
    for (const h of [e.headers, e.response && e.response.headers]) {
      const msHeader = headerGet(h, 'retry-after-ms');
      if (msHeader !== null && msHeader !== undefined && Number.isFinite(Number(msHeader))) return cap(Number(msHeader));
      const ms = parseRetryAfter(headerGet(h, 'retry-after'));
      if (ms !== null) return ms;
    }
  }

  const msg = String(err.message || '');
  let m = msg.match(/(\d+)m(\d+(?:\.\d+)?)s\b/i); // "6m12.5s"
  if (m) return cap(Number(m[1]) * 60000 + parseFloat(m[2]) * 1000);
  m = msg.match(/retry[\s_-]*after[\s"':=]*?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|secs?|seconds?|mins?|minutes?|s|m)?\b/i);
  if (m) return cap(unitToMs(m[1], m[2]));
  m = msg.match(/retryDelay["'\s:=]*?(\d+(?:\.\d+)?)\s*(ms|s|m)?/i);
  if (m) return cap(unitToMs(m[1], m[2]));
  m = msg.match(/(?:try|retry) again in\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|secs?|seconds?|mins?|minutes?|s|m)\b/i);
  if (m) return cap(unitToMs(m[1], m[2]));
  return null;
}

/* ---------- classifyError ---------- */

function makeInfo(type, rawErr, extra = {}) {
  const d = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.unknown;
  return {
    kind: 'error_info',
    type,
    severity: extra.severity || d.severity,
    status: extra.status || d.status,
    upstreamStatus: extra.upstreamStatus || null,
    retryable: extra.retryable !== undefined ? extra.retryable : d.retryable,
    retryAfterMs: extra.retryAfterMs !== undefined ? extra.retryAfterMs : null,
    scope: extra.scope || null,
    code: extra.code || null,
    details: extra.details || null,
    message: sanitize(rawErr && rawErr.message ? rawErr.message : safeToString(rawErr), { maxLen: 300 })
  };
}

function fromAppError(err) {
  const type = Object.values(ERROR_TYPES).includes(err.type) ? err.type : ERROR_TYPES.UNKNOWN;
  const d = TYPE_DEFAULTS[type];
  const scope = err.scope || (type === 'rate_limit' ? 'provider' : null);
  let status = Number.isInteger(err.status) ? err.status : d.status;
  if (type === 'rate_limit' && !Number.isInteger(err.status)) status = scope === 'user' ? 429 : 503;
  return makeInfo(type, err, {
    severity: err.severity || d.severity,
    status,
    retryable: typeof err.retryable === 'boolean' ? err.retryable : d.retryable,
    retryAfterMs: typeof err.retryAfterMs === 'number' ? err.retryAfterMs : null,
    scope,
    code: err.code,
    details: Array.isArray(err.details) ? err.details : null
  });
}

function rateLimitInfo(err, ctx, upstreamStatus) {
  const scope = ctx.scope === 'user' ? 'user' : 'provider';
  const retryAfterMs = extractRetryAfterMs(err);
  const msg = String(err.message || '');
  // "daily quota / billing" jaisi sakht limit: turant retry ka fayda nahi
  const hardQuota = retryAfterMs === null && QUOTA_HARD.test(msg);
  return makeInfo('rate_limit', err, {
    status: scope === 'user' ? 429 : 503,
    upstreamStatus,
    retryable: !hardQuota,
    retryAfterMs,
    scope,
    code: hardQuota ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED'
  });
}

function serverInfo(err, status) {
  const retryable = [500, 502, 503, 529].includes(status) || (status >= 520 && status <= 526 && status !== 522 && status !== 524);
  return makeInfo('server', err, {
    upstreamStatus: status,
    status: retryable ? 503 : 502,
    retryable,
    severity: retryable ? 'warning' : 'critical',
    retryAfterMs: extractRetryAfterMs(err)
  });
}

// Koi bhi error (Error, string, object, provider ka HTTP error) => {type, severity, status, retryable, ...}
function classifyError(input, ctx = {}) {
  const err = toErrorLike(input);
  if (err instanceof AppError) return fromAppError(err);

  const msg = String(err.message || '');
  const name = String(err.name || '');
  const codes = codesOf(err);
  const status = statusOf(err);

  // Pehle hamare apne (engine) errors: calculation / validation
  if (name === 'CalculationError' || CALC_MESSAGE.test(msg)) return makeInfo('calculation', err);
  if (name === 'ValidationError' || (status === null && VALIDATION_MESSAGE.test(msg))) {
    return makeInfo('validation', err, { details: Array.isArray(err.details) ? err.details : null });
  }

  // HTTP status (provider response)
  if (status !== null) {
    if (status === 401 || status === 403) return makeInfo('auth', err, { upstreamStatus: status, code: 'AUTH_FAILED' });
    // 402 = credits/billing khatam: account ki dikkat hai, user ke bas ki nahi
    if (status === 402) return makeInfo('auth', err, { upstreamStatus: status, code: 'BILLING' });
    if (status === 429) return rateLimitInfo(err, ctx, status);
    if (status === 408 || status === 504 || status === 522 || status === 524) {
      return makeInfo('timeout', err, { upstreamStatus: status });
    }
    if (status === 413) return makeInfo('validation', err, { status: 413, upstreamStatus: status, code: 'PAYLOAD_TOO_LARGE' });
    if (status === 404) return makeInfo('api', err, { upstreamStatus: status, code: 'NOT_FOUND' }); // jaise purana/band model
    if (status === 400 && AUTH_MESSAGE.test(msg)) return makeInfo('auth', err, { upstreamStatus: status, code: 'AUTH_FAILED' });
    if (status === 400 && RATE_MESSAGE.test(msg)) return rateLimitInfo(err, ctx, status);
    if (status >= 500) return serverInfo(err, status);
    if (status >= 400) return makeInfo('api', err, { upstreamStatus: status, code: 'API_REJECTED' });
  }

  // Network / timeout (Node error codes, fetch failed)
  if (codes.some(c => NETWORK_CODES.has(c))) return makeInfo('network', err, { code: codes.find(c => NETWORK_CODES.has(c)) });
  if (codes.some(c => TIMEOUT_CODES.has(c)) || name === 'TimeoutError' || name === 'AbortError') {
    return makeInfo('timeout', err, { code: codes.find(c => TIMEOUT_CODES.has(c)) || name.toUpperCase() });
  }

  // Message based detection
  if (AUTH_MESSAGE.test(msg)) return makeInfo('auth', err, { code: 'AUTH_FAILED' });
  if (RATE_MESSAGE.test(msg)) return rateLimitInfo(err, ctx, null);
  if (TIMEOUT_MESSAGE.test(msg)) return makeInfo('timeout', err);
  if (NETWORK_MESSAGE.test(msg)) return makeInfo('network', err);

  // Provider ne unreadable (HTML/ adhura JSON) jawab diya
  if (name === 'SyntaxError' && /JSON|Unexpected (?:token|end)/i.test(msg) && ctx.source === 'provider') {
    return makeInfo('api', err, { code: 'BAD_RESPONSE', retryable: true });
  }

  // Hamare apne code ke bugs
  if (/^(TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError)$/.test(name)) {
    return makeInfo('code', err, { code: name.toUpperCase() });
  }

  return makeInfo('unknown', err);
}

/* ========================================================================== */
/* 4. Friendly messages (Hinglish)                                            */
/* ========================================================================== */

const secondsOf = ms => Math.max(1, Math.min(3600, Math.ceil(ms / 1000)));

function friendlyMessage(infoOrError, opts = {}) {
  const info = infoOrError && infoOrError.kind === 'error_info' ? infoOrError : classifyError(infoOrError, opts);
  const wait = info.retryAfterMs !== null && info.retryAfterMs !== undefined
    ? secondsOf(info.retryAfterMs)
    : DEFAULT_RATE_LIMIT_WAIT[info.scope === 'user' ? 'user' : 'provider'];

  switch (info.type) {
    case 'validation':
      if (info.details && info.details.length) {
        return info.details.slice(0, 3).map(d => d.message).join('. ') + '. Kripya sahi value daalkar dobara try karein.';
      }
      return 'Aapne jo value di hai wo sahi nahi lagti. Amount, interest rate aur avadhi check karke dobara try karein.';
    case 'rate_limit':
      if (info.code === 'QUOTA_EXHAUSTED') {
        return 'Abhi service ki limit poori ho gayi hai. Kuch der baad dobara try karein.';
      }
      return info.scope === 'user'
        ? 'Aapne thode samay mein bahut sawal bhej diye hain. ' + wait + ' second ruk kar dobara try karein.'
        : 'Abhi bahut zyada log use kar rahe hain. ' + wait + ' second baad dobara try karein.';
    case 'timeout':
      return 'Jawab dene mein zyada der lag gayi. Thodi der baad dobara try karein.';
    case 'network':
      return 'Internet ya server se connection nahi ho paya. Connection check karke dobara try karein.';
    case 'server':
      return 'Server par abhi dikkat hai. Thodi der baad dobara try karein.';
    case 'api':
      return 'Assistant abhi jawab nahi de pa raha. Thodi der baad dobara try karein.';
    case 'auth':
      return 'Service abhi available nahi hai. Hum ise theek kar rahe hain, thodi der baad try karein.';
    case 'code':
      return 'Kuch gadbad ho gayi. Hum ise theek kar rahe hain. Dobara try karein.';
    case 'calculation':
      return 'Is calculation ka result bharosemand nahi tha, isliye main number nahi dikha raha. Inputs check karke dobara poochho.';
    default:
      return 'Kuch galat ho gaya. Dobara try karein.';
  }
}

/* ========================================================================== */
/* 5. Timeout, retry, circuit breaker                                         */
/* ========================================================================== */

// task: Promise ya function(signal) => Promise. Der hone par AppError(type: timeout) aur signal abort.
function withTimeout(task, ms, label = 'request') {
  const limit = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 120000) : 15000;
  const controller = new AbortController();
  let timer;

  let work;
  try {
    work = typeof task === 'function' ? Promise.resolve(task(controller.signal)) : Promise.resolve(task);
  } catch (e) {
    work = Promise.reject(e);
  }

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AppError({
        type: ERROR_TYPES.TIMEOUT,
        message: sanitize(label, { maxLen: 60 }) + ' timeout (' + limit + 'ms)',
        code: 'TIMEOUT'
      }));
    }, limit);
  });

  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

// Sirf temporary errors par, limited baar, backoff + jitter ke saath. Baaki turant throw.
async function retry(fn, opts = {}) {
  const o = {
    retries: 2,
    baseDelayMs: 400,
    maxDelayMs: 4000,
    factor: 2,
    jitter: 0.25,
    maxRetryAfterMs: 5000, // isse lamba Retry-After aaye to wait nahi, seedha error
    minRemainingMs: 1500,
    ...opts
  };
  const retries = clampInt(o.retries, 0, 3); // hard cap: baar-baar request nahi
  const sleep = typeof o.sleep === 'function' ? o.sleep : defaultSleep;
  const random = typeof o.random === 'function' ? o.random : Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      const info = classifyError(e, o.ctx || {});
      if (e && typeof e === 'object') {
        try { e.errorInfo = info; } catch (_) { /* frozen */ }
      }

      const allowed = typeof o.shouldRetry === 'function' ? o.shouldRetry(info, attempt, e) : info.retryable;
      if (!allowed || attempt >= retries) throw e;

      let delay;
      if (info.retryAfterMs !== null && info.retryAfterMs !== undefined) {
        if (info.retryAfterMs > o.maxRetryAfterMs) throw e;
        delay = info.retryAfterMs;
      } else {
        const base = Math.min(o.maxDelayMs, o.baseDelayMs * Math.pow(o.factor, attempt));
        delay = Math.max(0, Math.round(base * (1 + (random() * 2 - 1) * o.jitter)));
      }

      if (o.deadlineAt && o.deadlineAt - Date.now() - delay < o.minRemainingMs) throw e;

      if (typeof o.onRetry === 'function') {
        try { o.onRetry({ attempt: attempt + 1, delayMs: delay, type: info.type }); } catch (_) { /* ignore */ }
      }
      await sleep(delay);
    }
  }
}

// Lagataar fail hone wale provider ko kuch der ke liye band kar deta hai (baar-baar request se bachne ke liye)
function createCircuitBreaker(opts = {}) {
  const threshold = clampInt(opts.failureThreshold === undefined ? 5 : opts.failureThreshold, 1, 100);
  const cooldownMs = Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : 30000;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const state = new Map();
  const COUNTED = new Set(['network', 'timeout', 'server', 'rate_limit']);

  const isOpen = key => {
    const s = state.get(key);
    return Boolean(s && s.openedAt && now() - s.openedAt < cooldownMs);
  };

  return {
    isOpen,
    reset: key => state.delete(key),
    async exec(key, fn) {
      if (isOpen(key)) {
        const s = state.get(key);
        throw new AppError({
          type: ERROR_TYPES.SERVER,
          message: 'provider temporarily paused',
          code: 'CIRCUIT_OPEN',
          retryable: false,
          retryAfterMs: Math.max(0, cooldownMs - (now() - s.openedAt))
        });
      }
      try {
        const result = await fn();
        state.delete(key);
        return result;
      } catch (e) {
        if (COUNTED.has(classifyError(e).type)) {
          const s = state.get(key) || { failures: 0, openedAt: 0 };
          s.failures++;
          if (s.failures >= threshold) s.openedAt = now();
          state.set(key, s);
        }
        throw e;
      }
    }
  };
}

/* ========================================================================== */
/* 6. Calculation protection                                                  */
/* ========================================================================== */

const calcError = (message, details) =>
  new AppError({ type: ERROR_TYPES.CALCULATION, message, code: 'CALC_INVALID', details });

const BAD_TEXT = /\bNaN\b|\bInfinity\b|\bundefined\b|\bnull\b|∞/;

// Result ke andar kahin bhi NaN/Infinity ya "₹NaN" jaisa text ho to path list deta hai
function findBadNumbers(x, path = 'result', out = [], depth = 0) {
  if (depth > 6 || out.length > 20) return out;
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) out.push(path);
  } else if (typeof x === 'string') {
    if (BAD_TEXT.test(x)) out.push(path);
  } else if (Array.isArray(x)) {
    x.forEach((v, i) => findBadNumbers(v, path + '[' + i + ']', out, depth + 1));
  } else if (x && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) findBadNumbers(v, path + '.' + k, out, depth + 1);
  }
  return out;
}

// "5,000" / true / "₹5,000" => number, galat ho to NaN
function parseInputNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return NaN;
  const cleaned = value.replace(/[₹,\s]/g, '').replace(/^(true|yes)$/i, '1').replace(/^(false|no)$/i, '0');
  return cleaned === '' ? NaN : Number(cleaned);
}

// "₹1,23,456" / "-₹5,000" => number, warna NaN
function parseINR(str) {
  if (typeof str === 'number') return str;
  if (typeof str !== 'string') return NaN;
  const m = str.trim().match(/^(-?)\s*₹?\s*(-?)([\d,]+(?:\.\d+)?)$/);
  if (!m) return NaN;
  const n = Number(m[3].replace(/,/g, ''));
  return m[1] === '-' || m[2] === '-' ? -n : n;
}

const NEGATIVE_OK = /surplus|vs_base|gain|earned|extra_cost/i;

// Tool ke result ki wazan-daar jaanch (negative EMI, maturity < principal jaisi galtiyan)
function checkFinancialResult(toolName, args, result) {
  const problems = [];
  const a = args && typeof args === 'object' ? args : {};

  if (!result || typeof result !== 'object') return { ok: false, problems: ['result khali ya galat format'] };
  problems.push(...findBadNumbers(result).map(p => p + ' invalid (NaN/Infinity)'));

  (function walk(x, key, depth) {
    if (depth > 5) return;
    if (typeof x === 'string') {
      if (/^-\s*₹/.test(x.trim()) && !NEGATIVE_OK.test(key)) problems.push(key + ' negative aaya');
    } else if (Array.isArray(x)) {
      x.forEach(v => walk(v, key, depth + 1));
    } else if (x && typeof x === 'object') {
      for (const [k, v] of Object.entries(x)) walk(v, k, depth + 1);
    }
  })(result, 'result', 0);

  const P = parseInputNumber(a.principal);
  const rate = parseInputNumber(a.annual_rate !== undefined ? a.annual_rate : a.annual_return);

  switch (toolName) {
    case 'calc_emi': {
      const emi = parseINR(result.monthly_emi);
      const total = parseINR(result.total_payment);
      if (Number.isFinite(emi) && emi <= 0) problems.push('monthly_emi 0 ya negative');
      if (Number.isFinite(total) && Number.isFinite(P) && rate >= 0 && total < P * 0.999) problems.push('total_payment loan se kam');
      break;
    }
    case 'calc_sip': {
      const fv = parseINR(result.future_value);
      const inv = parseINR(result.total_invested);
      if (Number.isFinite(fv) && Number.isFinite(inv) && rate >= 0 && fv < inv * 0.999) problems.push('future_value invest se kam');
      break;
    }
    case 'calc_lumpsum': {
      const mat = parseINR(result.maturity_amount);
      if (Number.isFinite(mat) && Number.isFinite(P) && rate >= 0 && mat < P * 0.999) problems.push('maturity amount principal se kam');
      break;
    }
    case 'calc_gst': {
      const base = parseINR(result.base_amount);
      const total = parseINR(result.total_amount);
      if (Number.isFinite(base) && Number.isFinite(total) && parseInputNumber(a.gst_rate) >= 0 && total < base - 0.01) problems.push('total base se kam');
      break;
    }
    default:
  }

  return { ok: problems.length === 0, problems };
}

// finance-engine ke runTool() ke result ko guard karta hai
function guardToolResult(toolName, args, result) {
  if (result && typeof result === 'object' && result.error) {
    const info = classifyError(new Error(String(result.error)));
    const type = info.type === 'calculation' ? ERROR_TYPES.CALCULATION : ERROR_TYPES.VALIDATION;
    return {
      ok: false,
      error: new AppError({
        type,
        message: String(result.error),
        code: type === ERROR_TYPES.CALCULATION ? 'CALC_INVALID' : 'INVALID_INPUT',
        details: type === ERROR_TYPES.VALIDATION ? [{ field: toolName, message: String(result.error) }] : undefined
      })
    };
  }
  const check = checkFinancialResult(toolName, args, result);
  if (!check.ok) {
    return { ok: false, error: calcError('Result jaanch mein fail hua: ' + check.problems.slice(0, 3).join('; ')) };
  }
  return { ok: true, result };
}

/* ========================================================================== */
/* 7. Reports + logging                                                       */
/* ========================================================================== */

const createRequestId = () => 'req_' + crypto.randomBytes(6).toString('hex');
const REQUEST_ID_RE = /^[\w:.-]{6,80}$/;

function requestIdFrom(req) {
  const h = (req && req.headers) || {};
  const incoming = h['x-request-id'] || h['x-vercel-id'];
  return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : createRequestId();
}

const safeTag = v => (typeof v === 'string' && /^[\w .:()/#-]{1,60}$/.test(v) ? v : null);
const safeInt = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.round(Number(v))) : null);

// Sirf whitelisted fields: koi user message, input, header ya body kabhi report mein nahi jaata
function buildReport(info, ctx = {}) {
  return {
    id: typeof ctx.requestId === 'string' && REQUEST_ID_RE.test(ctx.requestId) ? ctx.requestId : createRequestId(),
    time: new Date().toISOString(),
    type: info.type,
    severity: info.severity,
    code: info.code || null,
    status: info.status,
    upstreamStatus: info.upstreamStatus || null,
    retryable: info.retryable,
    scope: info.scope || null,
    where: safeTag(ctx.where),
    provider: safeTag(ctx.provider),
    attempt: safeInt(ctx.attempt),
    durationMs: safeInt(ctx.durationMs),
    message: info.message
  };
}

// Error ko classify + sanitize + log karta hai. Kabhi throw nahi karta.
function logError(err, ctx = {}, opts = {}) {
  try {
    const info = classifyError(err, ctx);
    const report = buildReport(info, ctx);
    if (opts.debug) {
      const stack = err && err.stack ? sanitize(String(err.stack).split('\n').slice(0, 6).join('\n'), { maxLen: 800 }) : null;
      if (stack) report.stack = stack;
    }

    const logger = opts.logger || console;
    const level = report.severity === SEVERITY.CRITICAL ? 'error' : report.severity === SEVERITY.WARNING ? 'warn' : 'info';
    if (logger && typeof logger[level] === 'function') {
      try { logger[level](JSON.stringify({ event: 'error_report', ...report })); } catch (_) { /* logger fail */ }
    }
    return report;
  } catch (_) {
    return { id: createRequestId(), time: new Date().toISOString(), type: 'unknown', severity: 'warning', message: 'logging failed' };
  }
}

/* ========================================================================== */
/* 8. HTTP response + handler wrapper                                         */
/* ========================================================================== */

// Error => { status, headers, body, report }. Body mein kabhi internal detail/secret nahi.
function toHttpResponse(err, ctx = {}) {
  const info = classifyError(err, ctx);
  const requestId = typeof ctx.requestId === 'string' && REQUEST_ID_RE.test(ctx.requestId) ? ctx.requestId : createRequestId();
  const report = buildReport(info, { ...ctx, requestId });

  const needsWait = info.type === 'rate_limit' && info.code !== 'QUOTA_EXHAUSTED';
  const waitMs = info.retryAfterMs !== null && info.retryAfterMs !== undefined
    ? info.retryAfterMs
    : needsWait ? DEFAULT_RATE_LIMIT_WAIT[info.scope === 'user' ? 'user' : 'provider'] * 1000 : null;

  const body = {
    message: friendlyMessage(info),
    requestId,
    retryable: info.retryable
  };
  if (waitMs !== null && (info.retryable || needsWait)) body.retryAfterSeconds = secondsOf(waitMs);
  if (info.type === 'validation' && info.details && info.details.length) {
    body.details = info.details.slice(0, 5).map(d => ({ field: safeTag(d.field), message: sanitize(d.message, { maxLen: 160 }) }));
  }
  if (ctx.debug) body.debug = { type: info.type, severity: info.severity, detail: info.message };

  const headers = { 'X-Request-Id': requestId };
  if (body.retryAfterSeconds) headers['Retry-After'] = String(body.retryAfterSeconds);

  return { status: info.status, headers, body, report, info };
}

// Handler ko wrap karta hai: koi bhi throw => sanitized JSON error + request ID + structured log
function wrapHandler(handler, opts = {}) {
  return async function wrappedHandler(req, res) {
    const requestId = requestIdFrom(req);
    const started = Date.now();
    try {
      if (res && typeof res.setHeader === 'function') res.setHeader('X-Request-Id', requestId);
      return await handler(req, res, { requestId });
    } catch (err) {
      const ctx = { requestId, where: opts.where || 'handler', durationMs: Date.now() - started, debug: Boolean(opts.debug) };
      const out = toHttpResponse(err, ctx);
      logError(err, ctx, { logger: opts.logger, debug: opts.debug });
      if (typeof opts.onReport === 'function') {
        try { opts.onReport(out.report); } catch (_) { /* ignore */ }
      }
      if (!res || res.headersSent) return undefined;
      for (const [k, v] of Object.entries(out.headers)) {
        if (typeof res.setHeader === 'function') res.setHeader(k, v);
      }
      return res.status(out.status).json(out.body);
    }
  };
}

module.exports = {
  // types
  ERROR_TYPES, SEVERITY, TYPE_DEFAULTS, AppError, shouldAlert,
  // detection + messages
  classifyError, friendlyMessage, extractRetryAfterMs, parseRetryAfter,
  // timeout / retry / breaker
  withTimeout, retry, createCircuitBreaker,
  // calculation guards
  checkFinancialResult, guardToolResult, parseINR,
  // privacy + logging
  sanitize, createRequestId, requestIdFrom, buildReport, logError,
  // responses
  toHttpResponse, wrapHandler
};
