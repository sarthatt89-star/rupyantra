'use strict';

/*
 * Rupeyantra Engine Controller (lib/engine-controller.js)  --  PHASE 2
 *
 * Ek task leta hai, router se engine ka order puchta hai, engine chalata hai, jaanchta hai, fail ho to agla engine try karta hai.
 * execute() KABHI throw nahi karta: hamesha ek result envelope (lib/contracts.js) lautata hai.
 *
 * Niyam:
 *  - Task galat ho => invalid_input (koi engine nahi chalta).
 *  - Engine ko max task.timeout_ms (bacha hua waqt) milta hai; der se aaya jawab ignore.
 *  - Engine ka validation error => turant invalid_input, fallback nahi (input hi galat hai).
 *  - Network/server jaise temporary error par usi engine ko sirf ek baar dobara.
 *  - Engine ka jawab contract se na mile (NaN, assumptions nahi...) => CONTRACT_BREACH, agla engine.
 *  - task.verify true aur verifier diya ho => alag tareeke se jaanch; fail => agla engine. Method chupke se nahi badalta:
 *    tried[] mein har fail likha jaata hai, fallback_used true.
 *  - Sab fail => failed_verification / timeout / unavailable, result hamesha null.
 */

const contracts = require('./contracts');
const eh = require('./error-handler');
const { route } = require('./engine-router');

const { STATUS } = contracts;

function createController(deps = {}) {
  const { registry, health } = deps;
  if (!registry || !health) throw new Error('controller ko registry aur health chahiye');
  const verifier = typeof deps.verifier === 'function' ? deps.verifier : null;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const maxAttempts = Number.isInteger(deps.maxAttempts) && deps.maxAttempts > 0 ? deps.maxAttempts : 3;

  function fail(task, status, code, message, extra) {
    return contracts.createResult(task, {
      status,
      error: { code, message: String(message).slice(0, 300) },
      tried: extra.tried || [],
      fallback_used: false,
      route_reason: extra.route_reason || null,
      duration_ms: Math.max(0, now() - extra.startedAt),
      warnings: extra.warnings || []
    });
  }

  async function execute(rawTask, opts = {}) {
    const startedAt = now();
    const v = contracts.validateTask(rawTask);
    if (!v.ok) {
      const stub = {
        request_id: rawTask && rawTask.request_id, task_id: rawTask && rawTask.task_id,
        operation: rawTask && rawTask.operation, inputs: {}, units: {}
      };
      const env = contracts.createResult(stub, {
        status: STATUS.INVALID_INPUT,
        error: { code: 'INVALID_TASK', message: v.errors.map(e => e.field + ': ' + e.message).join('; ').slice(0, 300) },
        duration_ms: 0
      });
      env.errors = v.errors;
      return env;
    }
    const task = v.task;
    const deadline = startedAt + task.timeout_ms;
    const plan = route(task, { registry, health, jobSize: opts.jobSize });
    const tried = [];
    const warnings = [];

    if (!plan.candidates.length) {
      return fail(task, STATUS.UNAVAILABLE, 'NO_ENGINE', plan.route_reason, { tried, route_reason: plan.route_reason, startedAt });
    }

    let attempts = 0;
    let sawVerify = false;
    let sawNonTimeout = false;

    for (let idx = 0; idx < plan.candidates.length; idx++) {
      const cand = plan.candidates[idx];
      const adapter = registry.get(cand.name);
      let retried = false;

      for (;;) {
        if (attempts >= maxAttempts) break;
        const remaining = deadline - now();
        if (remaining <= 0) break;
        attempts++;
        const t0 = now();
        let out;
        try {
          out = await eh.withTimeout(signal => adapter.run(task, { signal, deadlineAt: deadline }), remaining, cand.name);
        } catch (e) {
          const info = eh.classifyError(e);
          const latency = now() - t0;
          if (info.type === 'validation') {
            tried.push({ engine: cand.technology, reason: 'input galat: ' + info.message });
            return fail(task, STATUS.INVALID_INPUT, 'ENGINE_REJECTED_INPUT', info.message, { tried, route_reason: plan.route_reason, startedAt });
          }
          health.record(cand.name, false, latency, info.code || info.type);
          if (info.type !== 'timeout') sawNonTimeout = true;
          if (!retried && info.retryable && (info.type === 'network' || info.type === 'server') && deadline - now() > 0) {
            retried = true;
            continue;
          }
          tried.push({ engine: cand.technology, reason: info.type + ': ' + info.message });
          break;
        }

        // Engine ne jawab diya: contract jaanch
        const env = contracts.createResult(task, {
          status: STATUS.SUCCESS,
          result: out && out.result,
          assumptions: out && out.assumptions,
          engine: cand.technology,
          engine_version: (out && out.engine_version) || adapter.capability.version,
          units: out && out.units ? { ...task.units, ...out.units } : undefined,
          warnings: out && out.warnings,
          source_refs: out && out.source_refs,
          fallback_used: idx > 0 && tried.length > 0,
          tried,
          route_reason: cand.reason + '; ' + plan.route_reason,
          duration_ms: now() - startedAt
        });
        const chk = contracts.validateResultFor(task.operation, env);
        if (!chk.ok) {
          health.record(cand.name, false, now() - t0, 'CONTRACT_BREACH');
          sawNonTimeout = true;
          tried.push({ engine: cand.technology, reason: 'CONTRACT_BREACH: ' + chk.errors.slice(0, 3).map(e => e.field).join(',') });
          break;
        }

        if (task.verify && verifier) {
          let vr;
          try { vr = await verifier(task, env); } catch (e) { vr = { ok: false, message: 'verifier crash: ' + (e && e.message) }; }
          if (!vr || vr.ok !== true) {
            // Engine ka kasoor nahi bhi ho sakta, par jawab bina jaanch ke nahi dete
            health.record(cand.name, false, now() - t0, 'VERIFY_FAILED');
            sawVerify = true;
            sawNonTimeout = true;
            tried.push({ engine: cand.technology, reason: 'VERIFY_FAILED: ' + String((vr && vr.message) || 'jaanch mein mismatch').slice(0, 150) });
            break;
          }
          if (vr.method) env.verified_by = String(vr.method).slice(0, 80);
          env.verified = true;
        } else {
          env.verified = false;
        }

        health.record(cand.name, true, now() - t0);
        env.duration_ms = now() - startedAt;
        return env;
      }
    }

    const last = tried.length ? tried[tried.length - 1].reason : 'koi koshish nahi hui (waqt khatam)';
    if (sawVerify) return fail(task, STATUS.FAILED_VERIFICATION, 'VERIFY_FAILED', 'koi engine ka jawab jaanch pass nahi kar saka. ' + last, { tried, route_reason: plan.route_reason, startedAt, warnings });
    if (tried.length && !sawNonTimeout) return fail(task, STATUS.TIMEOUT, 'TIMEOUT', 'sab engine time par jawab nahi de paye. ' + last, { tried, route_reason: plan.route_reason, startedAt, warnings });
    if (!tried.length) return fail(task, STATUS.TIMEOUT, 'TIMEOUT', last, { tried, route_reason: plan.route_reason, startedAt, warnings });
    return fail(task, STATUS.UNAVAILABLE, 'ALL_ENGINES_FAILED', 'koi engine jawab nahi de paya. ' + last, { tried, route_reason: plan.route_reason, startedAt, warnings });
  }

  return { execute };
}

module.exports = { createController };
