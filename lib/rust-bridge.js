'use strict';

/*
 * Rupeyantra Rust bridge (lib/rust-bridge.js)
 *
 * The Rust engine (rust-engine/) runs in its OWN process or service; Vercel functions never run it themselves.
 * Nothing requires this file until you choose to call it, and it replaces no existing file or engine.
 *
 *   const r = await rust.call('rolling_stats', { values: [...], window: 20 })
 *   -> { ok: true, engine: 'rust', execution: {...}, result: {...} }
 *   -> { ok: false, code, error }              (never throws)
 *
 * Where Rust runs (checked on every call):
 *   RUST_SERVICE_URL (+ RUST_SERVICE_TOKEN)  service started with `rupeyantra-rust serve` (https, or http on this machine)
 *   RY_RUST=/path/to/rupeyantra-rust        local process (`run`), for development and GitHub Actions only
 * Neither set -> ENGINE_UNAVAILABLE. The caller then answers without Rust and must NOT say Rust was used.
 *
 * An answer counts as "computed by Rust" only if it carries the engine's own execution record (engine, function,
 * executed, success, execution_id, duration_ms, version). Nothing here invents those fields.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const APPROVED = Object.freeze(['csv_profile', 'batch_returns', 'rolling_stats']);

const LIMITS = Object.freeze({
  maxRequestBytes: 1900000,   // below the service's default 2,000,000 byte cap
  maxResponseBytes: 5000000,
  defaultTimeoutMs: 20000,
  maxTimeoutMs: 60000
});

const CODES = new Set(['BAD_REQUEST', 'NOT_APPROVED', 'INVALID_INPUT', 'NON_FINITE_RESULT', 'TOO_LARGE', 'RATE_LIMITED', 'TIMEOUT', 'INTERNAL_ERROR', 'ENGINE_UNAVAILABLE']);
const PROJECT = path.join(__dirname, '..', 'rust-engine');

const fail = (code, error) => ({ ok: false, code, error });
const UNAVAILABLE = fail('ENGINE_UNAVAILABLE', 'Rust engine abhi available nahi hai.');

/* ---------- configuration ---------- */

function config(env = process.env) {
  const url = String(env.RUST_SERVICE_URL || '').trim();
  if (url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null; // no plain http over the internet
    if (!local && !env.RUST_SERVICE_TOKEN) return null;                                // a public service must need a token
    return { mode: 'service', url: u.origin + u.pathname.replace(/\/+$/, '') + '/run', token: String(env.RUST_SERVICE_TOKEN || '') };
  }
  if (env.RY_RUST) return { mode: 'local', bin: String(env.RY_RUST) };
  return null;
}

const isConfigured = (env = process.env) => config(env) !== null;

/* ---------- evidence ---------- */

/** Turns the engine's raw envelope into the bridge result. Only a complete execution record passes. */
function verify(answer, fn, roundTripMs) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return fail('BAD_RESPONSE', 'Rust ka jawab samajh nahi aaya.');
  if (answer.engine !== 'rust' || answer.function !== fn) return fail('BAD_RESPONSE', 'Jawab Rust engine se confirm nahi hua.');
  const recordOk = typeof answer.execution_id === 'string' && /^[0-9a-f]{32}$/.test(answer.execution_id)
    && typeof answer.duration_ms === 'number' && Number.isFinite(answer.duration_ms) && answer.duration_ms >= 0
    && typeof answer.version === 'string' && /^\d+\.\d+\.\d+/.test(answer.version)
    && typeof answer.executed === 'boolean' && typeof answer.success === 'boolean';
  if (!recordOk) return fail('BAD_RESPONSE', 'Rust ke jawab mein execution record poora nahi hai.');
  if (answer.success === false) {
    const e = answer.error && typeof answer.error === 'object' ? answer.error : {};
    const code = CODES.has(e.code) ? e.code : 'INTERNAL_ERROR';
    return fail(code, String(e.message || 'calculation failed').slice(0, 300));
  }
  if (answer.executed !== true || !answer.result || typeof answer.result !== 'object') return fail('BAD_RESPONSE', 'Rust ke jawab mein result nahi hai.');
  return {
    ok: true,
    engine: 'rust',
    execution: {
      function: answer.function,
      execution_id: answer.execution_id,
      duration_ms: answer.duration_ms,
      version: answer.version,
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
    if (text.length > LIMITS.maxResponseBytes) return { error: fail('BAD_RESPONSE', 'Rust ka jawab bahut bada hai.') };
    if (r.status === 401 || r.status === 403) return { error: fail('ENGINE_UNAVAILABLE', 'Rust service ne request accept nahi ki.') };
    try { return { answer: JSON.parse(text) }; } catch (e) { return { error: fail('BAD_RESPONSE', 'Rust ka jawab JSON nahi hai.') }; }
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? fail('TIMEOUT', 'Rust ne samay par jawab nahi diya.') : UNAVAILABLE };
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
      child = spawn(cfg.bin, ['run'], { stdio: ['pipe', 'pipe', 'ignore'], cwd: PROJECT });
    } catch (e) { return resolve({ error: UNAVAILABLE }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } finish({ error: fail('TIMEOUT', 'Rust ne samay par jawab nahi diya.') }); }, timeoutMs);
    child.on('error', () => finish({ error: UNAVAILABLE }));
    child.stdout.on('data', d => {
      out += d;
      if (out.length > LIMITS.maxResponseBytes) { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } finish({ error: fail('BAD_RESPONSE', 'Rust ka jawab bahut bada hai.') }); }
    });
    child.on('close', () => {
      const line = out.trim().split('\n').pop();
      try { finish({ answer: JSON.parse(line) }); } catch (e) { finish({ error: fail('BAD_RESPONSE', 'Rust ka jawab JSON nahi hai.') }); }
    });
    child.stdin.on('error', () => { /* handled by close/error */ });
    child.stdin.end(body);
  });
}

/* ---------- public API ---------- */

/** Runs one approved Rust function. Never throws. */
async function call(fn, args, options = {}) {
  if (typeof fn !== 'string' || !APPROVED.includes(fn)) return fail('NOT_APPROVED', 'Yeh function approved nahi hai.');
  const a = args === undefined ? {} : args;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return fail('INVALID_INPUT', 'args ek object hona chahiye.');
  let body;
  try { body = JSON.stringify({ function: fn, args: a }); } catch (e) { return fail('INVALID_INPUT', 'args JSON mein nahi badle ja sakte.'); }
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

/** True only when the result really came from Rust (complete execution record). The AI may say "Rust" only then. */
const mayClaimRust = res => !!(res && res.ok === true && res.engine === 'rust' && res.execution
  && /^[0-9a-f]{32}$/.test(String(res.execution.execution_id)) && res.result);

/** Text to hand to the AI with the numbers. Null without evidence, so nothing can be mislabelled. */
function aiBrief(res) {
  if (!mayClaimRust(res)) return null;
  const e = res.execution;
  return 'VERIFIED RUST RESULT (engine=rust, function=' + e.function + ', version ' + e.version +
    ', execution_id ' + e.execution_id + ', computed in ' + Math.round(e.duration_ms) + ' ms). ' +
    'You may say the Rust engine computed these numbers. Use only these numbers; do not add or change any figure. ' +
    'This is a report on the supplied data: not a prediction, not a guaranteed return, not advice.\n' +
    JSON.stringify(res.result).slice(0, 8000);
}

/** One line for the person: which engine produced the numbers (honest either way). */
function engineLabel(res) {
  return mayClaimRust(res) ? 'Rust engine v' + res.execution.version : 'Rust engine ka istemaal nahi hua';
}

module.exports = { call, isConfigured, mayClaimRust, aiBrief, engineLabel, verify, config, APPROVED, LIMITS };
