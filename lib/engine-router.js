'use strict';

/*
 * Rupeyantra Engine Router (lib/engine-router.js)  --  PHASE 2
 *
 * Tay karta hai ki kisi task ke liye kaun se engine, kis order mein try honge. Sirf fixed niyam: LLM nahi, random nahi.
 * Ek hi input par hamesha wahi order aata hai.
 *
 * Niyam, is kram mein (brief section 6):
 *  1. Jo engine ye operation karta hai.
 *  2. Jinka circuit breaker khula hai (pause), unhe hatao.
 *  3. Jo is job ka size nahi sambhal sakte, unhe hatao.
 *  4. Kaam ke type se pasand: chhota seedha hisaab => C++ phir JS; analysis => Python; bhaari simulation => Julia;
 *     security-sensitive => Rust; saved records => SQL.
 *  5. Barabar ho to: task ka engine_preference (sirf hint), phir sasta, phir tez, phir naam.
 *  6. JS reference jahan hai wahi aakhri safe fallback rehta hai (chhote kaam mein wo C++ ke turant baad aata hai).
 *  7. Kyun chuna, ye text mein likhna (route_reason).
 */

const COST_RANK = { cheap: 0, normal: 1, heavy: 2 };

// Kaam ka type. Naye operation (jaise simulation) ke liye yahan ek line jodni hai (Phase 5).
const TASK_CLASS = Object.freeze({
  default: 'small'
});

const CLASS_PREFERENCE = Object.freeze({
  small: ['cpp', 'js', 'rust', 'python', 'julia', 'sql'],
  analysis: ['python', 'julia', 'js', 'cpp', 'rust', 'sql'],
  simulation: ['julia', 'python', 'rust', 'cpp', 'js', 'sql'],
  validation: ['rust', 'js', 'cpp', 'python', 'julia', 'sql'],
  records: ['sql', 'js', 'cpp', 'python', 'julia', 'rust']
});

const classOf = operation => TASK_CLASS[operation] || TASK_CLASS.default;

// task: contracts.validateTask() ka task. Lautata hai { candidates, dropped, taskClass, route_reason }
function route(task, deps) {
  const { registry, health } = deps;
  const jobSize = Number.isInteger(deps.jobSize) && deps.jobSize > 0 ? deps.jobSize : 1;
  const taskClass = classOf(task.operation);
  const pref = CLASS_PREFERENCE[taskClass];
  const dropped = [];

  let pool = registry.supporting(task.operation);
  if (!pool.length) {
    return { candidates: [], dropped, taskClass, route_reason: 'koi engine ' + task.operation + ' nahi karta' };
  }

  pool = pool.filter(a => {
    if (health.isOpen(a.capability.name)) { dropped.push({ engine: a.capability.name, reason: 'circuit open (pause)' }); return false; }
    if (a.capability.max_job_size < jobSize) { dropped.push({ engine: a.capability.name, reason: 'job bahut bada (' + jobSize + ' > ' + a.capability.max_job_size + ')' }); return false; }
    return true;
  });

  const rank = tech => { const i = pref.indexOf(tech); return i === -1 ? 99 : i; };
  const hint = task.engine_preference;
  const key = a => [
    rank(a.capability.technology),
    hint && a.capability.technology === hint ? 0 : 1,
    COST_RANK[a.capability.cost_class],
    a.capability.typical_latency_ms,
    a.capability.name
  ];
  const cmp = (a, b) => {
    const x = key(a);
    const y = key(b);
    for (let i = 0; i < x.length; i++) {
      if (x[i] < y[i]) return -1;
      if (x[i] > y[i]) return 1;
    }
    return 0;
  };
  pool.sort(cmp);

  const candidates = pool.map((a, i) => ({
    name: a.capability.name,
    technology: a.capability.technology,
    reason: (i === 0 ? 'pehli pasand' : 'fallback #' + i) + ': ' + taskClass + ' kaam, ' + a.capability.technology + ' (' + a.capability.cost_class + ')'
  }));

  const first = candidates[0];
  const route_reason = first
    ? first.reason + '; ' + candidates.length + ' engine tayyar' + (dropped.length ? ', ' + dropped.length + ' hata diye gaye (' + dropped.map(d => d.engine + ': ' + d.reason).join(', ') + ')' : '')
    : 'sab engine hata diye gaye: ' + dropped.map(d => d.engine + ': ' + d.reason).join(', ');

  return { candidates, dropped, taskClass, route_reason };
}

module.exports = { route, classOf, TASK_CLASS, CLASS_PREFERENCE };
