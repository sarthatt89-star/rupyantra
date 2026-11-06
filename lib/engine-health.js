'use strict';

/*
 * Rupeyantra Engine Health (lib/engine-health.js)  --  PHASE 2
 *
 * Har engine ki sehat: kitni baar fail hua, kitni der lagi, aur circuit breaker.
 * Niyam (brief): lagataar 3 fail => 30 second ke liye engine pause. Pause ke baad ek koshish (half-open): chale to sab theek, na chale to
 * dobara pause.
 *
 * Dhyan: ye yaad ek chalte instance ki memory mein rehti hai. Vercel jaisi serverless jagah par kai instance alag-alag yaad rakhte hain,
 * isliye ye "aaj ke is instance ki raay" hai. Saajha health state SQL/KV mein rakhna Phase 4 ka kaam hai.
 * Is file mein koi network nahi.
 */

function createHealth(opts = {}) {
  const threshold = Number.isInteger(opts.failureThreshold) && opts.failureThreshold > 0 ? opts.failureThreshold : 3;
  const cooldownMs = Number.isFinite(opts.cooldownMs) && opts.cooldownMs >= 0 ? opts.cooldownMs : 30000;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const state = new Map();

  const get = name => {
    if (!state.has(name)) state.set(name, { failures: 0, successes: 0, openedAt: 0, lastLatencyMs: null, lastError: null });
    return state.get(name);
  };

  // true = abhi pause mein hai (is engine ko mat chalao)
  const isOpen = name => {
    const s = state.get(name);
    return Boolean(s && s.openedAt && now() - s.openedAt < cooldownMs);
  };

  function record(name, ok, latencyMs, errorCode) {
    const s = get(name);
    if (Number.isFinite(latencyMs)) s.lastLatencyMs = Math.round(latencyMs);
    if (ok) {
      s.successes++;
      s.failures = 0;
      s.openedAt = 0;
      s.lastError = null;
    } else {
      s.failures++;
      s.lastError = typeof errorCode === 'string' ? errorCode.slice(0, 60) : 'FAILED';
      if (s.failures >= threshold) s.openedAt = now();
    }
  }

  function snapshot(name) {
    const s = get(name);
    return {
      engine: name,
      status: isOpen(name) ? 'paused' : s.failures > 0 ? 'degraded' : 'ok',
      failures: s.failures,
      successes: s.successes,
      lastLatencyMs: s.lastLatencyMs,
      lastError: s.lastError,
      pausedForMs: isOpen(name) ? Math.max(0, cooldownMs - (now() - s.openedAt)) : 0
    };
  }

  return { isOpen, record, snapshot, reset: name => state.delete(name), threshold, cooldownMs };
}

module.exports = { createHealth };
