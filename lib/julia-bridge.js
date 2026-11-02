'use strict';

/*
 * Rupeyantra Julia bridge (lib/julia-bridge.js)
 *
 * The Julia engine (julia-engine/) runs in its OWN process or service; Vercel functions never run Julia.
 * This file is the only JavaScript that talks to it. It adds nothing to the existing site by itself: nothing requires it
 * until you choose to call it, and it replaces no existing file or C++ route.
 *
 *   await julia.call('sip_monte_carlo', { monthly_amount: 10000, annual_return: 12, annual_volatility: 15, months: 120 })
 *   -> { ok: true, engine: 'julia', evidence: {...}, result: {...} }
 *   -> { ok: false, code, error }            (never throws)
 *
 * Where Julia runs (checked on every call):
 *   JULIA_SERVICE_URL (+ JULIA_SERVICE_TOKEN)  HTTPS service that accepts POST /run  {fn, args}
 *   RY_JULIA=julia                             local process, for development and GitHub Actions only
 * Neither set -> ENGINE_UNAVAILABLE and the caller keeps using the existing C++/JS engines.
 *
 * Safety rules enforced here AND again inside Julia:
 *   - only the approved function names below can be requested (arbitrary code can never be sent)
 *   - request size, response size and run time are capped
 *   - an answer counts as "computed by Julia" only if it carries Julia's own evidence (engine, version, timing, same fn)
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const APPROVED = Object.freeze([
  'sip_monte_carlo', 'lumpsum_monte_carlo', 'sip_scenarios',
  'portfolio_analysis', 'portfolio_compare', 'correlation_matrix',
  'optimize_portfolio', 'efficient_frontier', 'goal_plan', 'goal_sensitivity',
  'matrix_operations', 'numerical_checks', 'stress_scenarios', 'volatility_stress'
]);

const LIMITS = Object.freeze({
  maxRequestBytes: 200000,   // same cap as the Julia side
  maxResponseBytes: 2000000,
  defaultTimeoutMs: 15000,
  maxTimeoutMs: 60000
});

const JULIA_CODES = new Set(['BAD_REQUEST', 'NOT_APPROVED', 'INVALID_INPUT', 'TOO_LARGE', 'INTERNAL_ERROR']);
const PROJECT = path.join(__dirname, '..', 'julia-engine');

const fail = (code, error) => ({ ok: false, code, error });
const UNAVAILABLE = fail('ENGINE_UNAVAILABLE', 'Julia engine abhi available nahi hai.');

/* ---------- configuration ---------- */

function config(env = process.env) {
  const url = String(env.JULIA_SERVICE_URL || '').trim();
  if (url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null; // no plain http over the internet
    if (!local && !env.JULIA_SERVICE_TOKEN) return null;                             // a public service must need a token
    return { mode: 'service', url: u.origin + u.pathname.replace(/\/+$/, '') + '/run', token: String(env.JULIA_SERVICE_TOKEN || '') };
  }
  if (env.RY_JULIA) return { mode: 'local', bin: String(env.RY_JULIA) };
  return null;
}

const isConfigured = (env = process.env) => config(env) !== null;

/* ---------- evidence ---------- */

/** Turns a raw answer from Julia into the bridge's result, or an error. Only a complete evidence block passes. */
function verify(answer, fn, roundTripMs) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return fail('BAD_RESPONSE', 'Julia ka jawab samajh nahi aaya.');
  if (answer.engine !== 'julia') return fail('BAD_RESPONSE', 'Jawab Julia engine se confirm nahi hua.');
  if (answer.ok === false) {
    const code = JULIA_CODES.has(answer.code) ? answer.code : 'INTERNAL_ERROR';
    return fail(code, String(answer.error || 'calculation failed').slice(0, 300));
  }
  const good = answer.ok === true
    && typeof answer.julia_version === 'string' && /^\d+\.\d+/.test(answer.julia_version)
    && answer.fn === fn
    && typeof answer.elapsed_ms === 'number' && Number.isFinite(answer.elapsed_ms) && answer.elapsed_ms >= 0
    && answer.result && typeof answer.result === 'object';
  if (!good) return fail('BAD_RESPONSE', 'Julia ke jawab mein pramaan (evidence) poora nahi hai.');
  return {
    ok: true,
    engine: 'julia',
    evidence: {
      julia_version: answer.julia_version,
      elapsed_ms: answer.elapsed_ms,
      threads: Number.isInteger(answer.threads) ? answer.threads : null,
      round_trip_ms: roundTripMs
    },
    result: answer.result
  };
}

/* ---------- transports ---------- */

async function viaService(cfg, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (cfg.token) headers.authorization = 'Bearer ' + cfg.token;
    const r = await fetch(cfg.url, { method: 'POST', headers, body, signal: ctl.signal, redirect: 'error' });
    const text = await r.text();
    if (text.length > LIMITS.maxResponseBytes) return { error: fail('BAD_RESPONSE', 'Julia ka jawab bahut bada hai.') };
    if (r.status === 401 || r.status === 403) return { error: fail('ENGINE_UNAVAILABLE', 'Julia service ne request accept nahi ki.') };
    try { return { answer: JSON.parse(text) }; } catch (e) { return { error: fail('BAD_RESPONSE', 'Julia ka jawab JSON nahi hai.') }; }
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? fail('TIMEOUT', 'Julia ne samay par jawab nahi diya.') : UNAVAILABLE };
  } finally {
    clearTimeout(timer);
  }
}

function viaLocal(cfg, body, timeoutMs) {
  return new Promise(resolve => {
    let out = '';
    let done = false;
    const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try {
      child = spawn(cfg.bin, ['--project=' + PROJECT, '-t', 'auto', path.join(PROJECT, 'bin', 'run.jl')], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) { return resolve({ error: UNAVAILABLE }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } finish({ error: fail('TIMEOUT', 'Julia ne samay par jawab nahi diya.') }); }, timeoutMs);
    child.on('error', () => finish({ error: UNAVAILABLE }));
    child.stdout.on('data', d => {
      out += d;
      if (out.length > LIMITS.maxResponseBytes) { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } finish({ error: fail('BAD_RESPONSE', 'Julia ka jawab bahut bada hai.') }); }
    });
    child.on('close', () => {
      const line = out.trim().split('\n').pop();
      try { finish({ answer: JSON.parse(line) }); } catch (e) { finish({ error: fail('BAD_RESPONSE', 'Julia ka jawab JSON nahi hai.') }); }
    });
    child.stdin.on('error', () => { /* handled by close/error */ });
    child.stdin.end(body);
  });
}

/* ---------- public API ---------- */

/** Runs one approved Julia function. Never throws. */
async function call(fn, args, options = {}) {
  if (typeof fn !== 'string' || !APPROVED.includes(fn)) return fail('NOT_APPROVED', 'Yeh function approved nahi hai.');
  const a = args === undefined ? {} : args;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return fail('INVALID_INPUT', 'args ek object hona chahiye.');
  let body;
  try { body = JSON.stringify({ fn, args: a }); } catch (e) { return fail('INVALID_INPUT', 'args JSON mein nahi badle ja sakte.'); }
  if (Buffer.byteLength(body) > LIMITS.maxRequestBytes) return fail('TOO_LARGE', 'Request bahut badi hai.');
  const cfg = options.env ? config(options.env) : config();
  if (!cfg) return UNAVAILABLE;
  const t = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(t, LIMITS.maxTimeoutMs) : LIMITS.defaultTimeoutMs;
  const t0 = Date.now();
  const r = cfg.mode === 'service' ? await viaService(cfg, body, timeoutMs) : await viaLocal(cfg, body, timeoutMs);
  if (r.error) return r.error;
  return verify(r.answer, fn, Date.now() - t0);
}

/** True only when the result really came from Julia (complete evidence). The AI may say "Julia" only when this is true. */
const mayClaimJulia = res => !!(res && res.ok === true && res.engine === 'julia' && res.evidence
  && typeof res.evidence.julia_version === 'string' && res.result);

/** Short text to hand to the AI together with the numbers. Returns null without evidence, so nothing can be mislabelled. */
function aiBrief(res) {
  if (!mayClaimJulia(res)) return null;
  const e = res.evidence;
  return 'VERIFIED JULIA RESULT (engine=julia, version ' + e.julia_version + ', computed in ' + Math.round(e.elapsed_ms) + ' ms). ' +
    'You may say Julia computed these numbers. Use only these numbers; do not add or change any figure. ' +
    'This is a model on the inputs given, not a prediction or advice.\n' + JSON.stringify(res.result).slice(0, 6000);
}

/** One line for the person: which engine produced the numbers (honest either way). */
function engineLabel(res) {
  return mayClaimJulia(res) ? 'Julia engine v' + res.evidence.julia_version : 'Julia engine ka istemaal nahi hua';
}

module.exports = { call, isConfigured, mayClaimJulia, aiBrief, engineLabel, verify, config, APPROVED, LIMITS };
