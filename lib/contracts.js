'use strict';

/*
 * Rupeyantra Contracts (lib/contracts.js)  --  PHASE 1
 *
 * Saare engines (JS, C++, Python, Julia, Rust, SQL) ke liye ek hi "task" aur "result" ka format.
 * Ye file sirf format, naam aur jaanch ki niyam batati hai. Ye koi calculation nahi karti, koi network/engine nahi chhoti,
 * aur api/chat.js ko nahi chhoti. Controller aur adapters (Phase 2) isi par bante hain.
 *
 * Hisse:
 *  1. Naam aur enums ........... ENGINES, STATUS, UNITS, CONTRACT_VERSION
 *  2. Operations registry ...... OPERATIONS (kaun sa kaam, kaun se input, kis unit mein, kya limit)
 *  3. Task envelope ............ createTask(), validateTask()
 *  4. Result envelope .......... createResult(), validateResult()
 *  5. Capability record ........ validateCapability()  (router Phase 2 mein inhi se engine chunega)
 *  6. Tolerance ................ withinTolerance()  (engines ka jawab milane ke liye)
 *
 * Niyam: galat ya adhura task/result kabhi chupke se theek nahi hota; { ok:false, errors:[...] } milta hai.
 * Inputs mein koi personal pehchaan (PAN, Aadhaar, account/card number, OTP, password...) nahi aa sakti.
 * Tests: tests/contracts.test.js
 */

const crypto = require('node:crypto');

/* ========================================================================== */
/* 1. Naam aur enums                                                          */
/* ========================================================================== */

const CONTRACT_VERSION = '1.0';

const ENGINES = Object.freeze(['js', 'cpp', 'python', 'julia', 'rust', 'sql']);

const STATUS = Object.freeze({
  SUCCESS: 'success',
  INVALID_INPUT: 'invalid_input',
  FAILED_VERIFICATION: 'failed_verification',
  UNAVAILABLE: 'unavailable',
  TIMEOUT: 'timeout'
});

// Har input ki ek unit hoti hai; unit se hi range ke niyam lagte hain
const UNITS = Object.freeze({
  inr: { label: 'rupaye', min: 0, max: 1e12 },
  percent: { label: 'percent', min: 0, max: 100 },
  years: { label: 'saal', min: 0, max: 100 },
  months: { label: 'mahine', min: 0, max: 1200 },
  count: { label: 'ginti', min: 0, max: 1000 },
  flag: { label: '0/1', min: 0, max: 1 }
});

const COST_CLASS = Object.freeze(['cheap', 'normal', 'heavy']);
const DEPLOYMENT = Object.freeze(['in-process', 'wasm', 'remote']);

const ID_RE = /^[\w:.-]{6,80}$/;
const OP_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const PERSONAL_KEY = /(^|_)(pan|aadhaar|aadhar|account|acct|card|cvv|cvc|otp|pin|password|passwd|phone|mobile|email|ifsc|upi)(_|$)/i;
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30000;

/* ========================================================================== */
/* 2. Operations registry                                                     */
/* ========================================================================== */
/*
 * Har operation: domain.naam, uske inputs (unit, zaroori ya nahi, apni range), aur ye ki result "projection" hai ya nahi.
 * projection = true: result ek andaza hai (assumed return), guaranteed nahi; result mein guaranteed:false aana zaroori.
 * oneOf = [[a, b]]: in mein se kam se kam ek input zaroori (jaise years ya months).
 * Ye naam aur inputs lib/finance-engine.js ke tools se milaye gaye hain (js_tool = unka naam).
 */
const principal = { unit: 'inr', required: true, min: 0.01 };
const rate = { unit: 'percent', required: true };
const yearsReq = { unit: 'years', required: true, min: 0.01 };

const OPERATIONS = Object.freeze({
  'loan.emi': {
    domain: 'loan', js_tool: 'calc_emi', projection: false,
    inputs: { principal, annual_rate: rate, years: { unit: 'years', min: 0.01 }, months: { unit: 'months', min: 1 } },
    oneOf: [['years', 'months']]
  },
  'loan.compare_emi': {
    domain: 'loan', js_tool: 'compare_emi', projection: false,
    inputs: {
      principal, annual_rate: rate, years: yearsReq,
      alt_annual_rate: { unit: 'percent' }, alt_years: { unit: 'years', min: 0.01 }
    }
  },
  'invest.sip': {
    domain: 'invest', js_tool: 'calc_sip', projection: true,
    inputs: { monthly_amount: { unit: 'inr', required: true, min: 0.01 }, annual_return: rate, years: yearsReq }
  },
  'invest.compare_sip': {
    domain: 'invest', js_tool: 'compare_sip', projection: true,
    inputs: {
      monthly_amount: { unit: 'inr', required: true, min: 0.01 }, years: yearsReq,
      conservative_return: { unit: 'percent' }, moderate_return: { unit: 'percent' }, high_return: { unit: 'percent' }
    }
  },
  'invest.lumpsum': {
    domain: 'invest', js_tool: 'calc_lumpsum', projection: true,
    inputs: { principal, annual_rate: rate, years: yearsReq, compounds_per_year: { unit: 'count', min: 1 } }
  },
  'invest.cagr': {
    domain: 'invest', js_tool: 'calc_cagr', projection: false,
    inputs: {
      start_value: { unit: 'inr', required: true, min: 0.01 }, end_value: { unit: 'inr', required: true, min: 0 }, years: yearsReq
    }
  },
  'interest.simple': {
    domain: 'interest', js_tool: 'calc_simple_interest', projection: false,
    inputs: { principal, annual_rate: rate, years: yearsReq }
  },
  'tax.gst': {
    domain: 'tax', js_tool: 'calc_gst', projection: false,
    inputs: { amount: { unit: 'inr', required: true, min: 0 }, gst_rate: rate, inclusive: { unit: 'flag', required: true } }
  },
  'inflation.future_cost': {
    domain: 'inflation', js_tool: 'calc_inflation', projection: true,
    inputs: { current_amount: { unit: 'inr', required: true, min: 0 }, annual_inflation: rate, years: yearsReq }
  },
  'budget.summary': {
    domain: 'budget', js_tool: 'calc_budget', projection: false,
    inputs: {
      monthly_income: { unit: 'inr', required: true, min: 0 }, monthly_expenses: { unit: 'inr', required: true, min: 0 },
      goal_amount: { unit: 'inr' }, current_savings: { unit: 'inr' }, annual_return: { unit: 'percent' }
    }
  }
});

/* ========================================================================== */
/* helpers                                                                    */
/* ========================================================================== */

const isPlainObject = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const err = (field, message) => ({ field, message });
const newId = prefix => prefix + '_' + crypto.randomBytes(6).toString('hex');

// 5000000, "5000000", "50,00,000", "₹50,00,000", true/false => number; galat ho to NaN
function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return NaN;
  const t = value.trim().replace(/[₹,\s]/g, '').replace(/^(true|yes)$/i, '1').replace(/^(false|no)$/i, '0');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

// result ke andar kahin bhi NaN / Infinity ya "NaN" text ho to path list karta hai
function findBadNumbers(x, path = 'result', out = [], depth = 0) {
  if (depth > 8 || out.length >= 20) return out;
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) out.push(path);
  } else if (typeof x === 'string') {
    if (/\bNaN\b|\bInfinity\b|\bundefined\b/.test(x)) out.push(path);
  } else if (Array.isArray(x)) {
    x.forEach((v, i) => findBadNumbers(v, path + '[' + i + ']', out, depth + 1));
  } else if (isPlainObject(x)) {
    for (const [k, v] of Object.entries(x)) findBadNumbers(v, path + '.' + k, out, depth + 1);
  }
  return out;
}

/* ========================================================================== */
/* 3. Task envelope                                                           */
/* ========================================================================== */

// Sirf jaanch: { ok, errors, task } . task = saaf kiya hua (numbers number ban gaye, defaults lage)
function validateTask(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: [err('task', 'task ek object hona chahiye')], task: null };

  if (raw.contract_version !== undefined && String(raw.contract_version).split('.')[0] !== CONTRACT_VERSION.split('.')[0]) {
    errors.push(err('contract_version', 'ye version supported nahi: ' + String(raw.contract_version)));
  }
  if (typeof raw.request_id !== 'string' || !ID_RE.test(raw.request_id)) errors.push(err('request_id', 'request_id sahi format mein nahi'));
  if (typeof raw.task_id !== 'string' || !ID_RE.test(raw.task_id)) errors.push(err('task_id', 'task_id sahi format mein nahi'));

  const op = OPERATIONS[raw.operation];
  if (typeof raw.operation !== 'string' || !OP_RE.test(raw.operation)) {
    errors.push(err('operation', 'operation "domain.naam" format mein hona chahiye'));
  } else if (!op) {
    errors.push(err('operation', 'ye operation maujood nahi: ' + raw.operation));
  } else if (raw.domain !== op.domain) {
    errors.push(err('domain', 'domain "' + op.domain + '" hona chahiye is operation ke liye'));
  }

  if (raw.engine_preference !== undefined && raw.engine_preference !== null && !ENGINES.includes(raw.engine_preference)) {
    errors.push(err('engine_preference', 'engine_preference sirf ek hint hai aur known engine ka naam hona chahiye'));
  }
  if (raw.verify !== undefined && typeof raw.verify !== 'boolean') errors.push(err('verify', 'verify true ya false hona chahiye'));

  let timeout = DEFAULT_TIMEOUT_MS;
  if (raw.timeout_ms !== undefined) {
    timeout = Number(raw.timeout_ms);
    if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
      errors.push(err('timeout_ms', 'timeout_ms ' + MIN_TIMEOUT_MS + ' se ' + MAX_TIMEOUT_MS + ' ke beech poora number ho'));
    }
  }

  const dependsOn = raw.depends_on === undefined ? [] : raw.depends_on;
  if (!Array.isArray(dependsOn) || dependsOn.length > 20 || dependsOn.some(d => typeof d !== 'string' || !ID_RE.test(d))) {
    errors.push(err('depends_on', 'depends_on task_id ki chhoti list honi chahiye'));
  } else if (dependsOn.includes(raw.task_id)) {
    errors.push(err('depends_on', 'task apne aap par depend nahi kar sakta'));
  }

  const inputs = {};
  if (!isPlainObject(raw.inputs)) {
    errors.push(err('inputs', 'inputs ek object hona chahiye'));
  } else if (op) {
    for (const key of Object.keys(raw.inputs)) {
      if (PERSONAL_KEY.test(key)) {
        errors.push(err(key, 'personal pehchaan (PAN, Aadhaar, account/card, OTP, password...) is format mein nahi aa sakti'));
      } else if (!op.inputs[key]) {
        errors.push(err(key, 'ye input is operation mein nahi hota'));
      }
    }
    for (const [key, spec] of Object.entries(op.inputs)) {
      const v = raw.inputs[key];
      if (v === undefined || v === null || v === '') {
        if (spec.required) errors.push(err(key, key + ' dena zaroori hai'));
        continue;
      }
      const n = parseNumber(v);
      const unit = UNITS[spec.unit];
      const lo = spec.min !== undefined ? spec.min : unit.min;
      const hi = spec.max !== undefined ? spec.max : unit.max;
      if (!Number.isFinite(n)) errors.push(err(key, key + ' sahi number hona chahiye (' + unit.label + ')'));
      else if (n < lo || n > hi) errors.push(err(key, key + ' ' + lo + ' se ' + hi + ' ' + unit.label + ' ke beech hona chahiye'));
      else inputs[key] = n;
    }
    for (const group of op.oneOf || []) {
      if (!group.some(k => inputs[k] !== undefined)) errors.push(err(group.join('/'), group.join(' ya ') + ' mein se ek dena zaroori hai'));
    }
  }

  if (errors.length) return { ok: false, errors, task: null };

  const units = {};
  for (const key of Object.keys(inputs)) units[key] = op.inputs[key].unit;
  return {
    ok: true,
    errors: [],
    task: {
      contract_version: CONTRACT_VERSION,
      request_id: raw.request_id,
      task_id: raw.task_id,
      domain: raw.domain,
      operation: raw.operation,
      inputs,
      units,
      engine_preference: raw.engine_preference || null,
      verify: raw.verify === undefined ? true : raw.verify,
      timeout_ms: timeout,
      depends_on: dependsOn.slice()
    }
  };
}

// Kaam ka task banata hai (id aur defaults khud lagata hai) aur jaanch bhi karta hai
function createTask(partial = {}) {
  const operation = partial.operation;
  const op = OPERATIONS[operation];
  return validateTask({
    request_id: newId('req'),
    task_id: newId('task'),
    domain: op ? op.domain : undefined,
    ...partial
  });
}

/* ========================================================================== */
/* 4. Result envelope                                                         */
/* ========================================================================== */

// Task + engine ka natija => result envelope. Jaanch alag se validateResult() mein hoti hai.
function createResult(task, fields = {}) {
  const status = fields.status || STATUS.SUCCESS;
  const ok = status === STATUS.SUCCESS;
  const op = task && OPERATIONS[task.operation];
  const envelope = {
    contract_version: CONTRACT_VERSION,
    request_id: task && task.request_id,
    task_id: task && task.task_id,
    status,
    result: ok ? (fields.result === undefined ? null : fields.result) : null,
    inputs: task && task.inputs ? { ...task.inputs } : {},
    units: fields.units || (task && task.units) || {},
    assumptions: Array.isArray(fields.assumptions) ? fields.assumptions.slice() : [],
    source_refs: Array.isArray(fields.source_refs) ? fields.source_refs.slice() : [],
    engine: fields.engine || null,
    engine_version: fields.engine_version || null,
    fallback_used: Boolean(fields.fallback_used),
    tried: Array.isArray(fields.tried) ? fields.tried.slice() : [],
    warnings: Array.isArray(fields.warnings) ? fields.warnings.slice() : [],
    route_reason: fields.route_reason || null,
    duration_ms: fields.duration_ms === undefined ? 0 : fields.duration_ms,
    error: ok ? null : (fields.error || null)
  };
  if (ok && op && op.projection) envelope.guaranteed = false;
  return envelope;
}

function validateResult(r) {
  const errors = [];
  if (!isPlainObject(r)) return { ok: false, errors: [err('result_envelope', 'result envelope object hona chahiye')] };

  if (String(r.contract_version).split('.')[0] !== CONTRACT_VERSION.split('.')[0]) errors.push(err('contract_version', 'version supported nahi'));
  if (typeof r.request_id !== 'string' || !ID_RE.test(r.request_id)) errors.push(err('request_id', 'request_id sahi nahi'));
  if (typeof r.task_id !== 'string' || !ID_RE.test(r.task_id)) errors.push(err('task_id', 'task_id sahi nahi'));
  if (!Object.values(STATUS).includes(r.status)) errors.push(err('status', 'status known nahi: ' + String(r.status)));
  if (!isPlainObject(r.inputs)) errors.push(err('inputs', 'inputs echo hona chahiye'));
  if (!isPlainObject(r.units)) errors.push(err('units', 'units object hona chahiye'));
  for (const f of ['assumptions', 'source_refs', 'tried', 'warnings']) {
    if (!Array.isArray(r[f])) errors.push(err(f, f + ' list honi chahiye'));
  }
  if (typeof r.fallback_used !== 'boolean') errors.push(err('fallback_used', 'fallback_used true/false hona chahiye'));
  if (typeof r.duration_ms !== 'number' || !Number.isFinite(r.duration_ms) || r.duration_ms < 0) errors.push(err('duration_ms', 'duration_ms 0 ya usse zyada number ho'));
  if (r.engine !== null && !ENGINES.includes(r.engine)) errors.push(err('engine', 'engine known nahi'));

  const tried = Array.isArray(r.tried) ? r.tried : [];
  tried.forEach((t, i) => {
    if (!isPlainObject(t) || !ENGINES.includes(t.engine) || typeof t.reason !== 'string') {
      errors.push(err('tried[' + i + ']', 'har tried entry {engine, reason} ho'));
    }
  });
  if (r.fallback_used === true && (!tried.length || tried[0].engine === r.engine)) {
    errors.push(err('fallback_used', 'fallback ka matlab hai pehle koi aur engine try hua aur fail hua (tried mein dikhna chahiye)'));
  }

  if (r.status === STATUS.SUCCESS) {
    if (!isPlainObject(r.result)) errors.push(err('result', 'success mein result object hona chahiye'));
    else findBadNumbers(r.result).forEach(p => errors.push(err(p, 'NaN/Infinity/undefined result mein nahi ho sakta')));
    if (!r.engine) errors.push(err('engine', 'success mein engine ka naam zaroori hai'));
    if (typeof r.engine_version !== 'string' || !r.engine_version) errors.push(err('engine_version', 'success mein engine_version zaroori hai'));
    if (!Array.isArray(r.assumptions) || !r.assumptions.length || r.assumptions.some(a => typeof a !== 'string' || !a)) {
      errors.push(err('assumptions', 'success mein kam se kam ek assumption likhi honi chahiye'));
    }
    if (typeof r.route_reason !== 'string' || !r.route_reason) errors.push(err('route_reason', 'route_reason zaroori hai: engine kyun chuna gaya'));
    if (r.error !== null) errors.push(err('error', 'success mein error null ho'));
  } else if (Object.values(STATUS).includes(r.status)) {
    if (r.result !== null) errors.push(err('result', 'success ke bina result null hona chahiye; adhura number nahi dikhana'));
    if (!isPlainObject(r.error) || typeof r.error.code !== 'string' || typeof r.error.message !== 'string') {
      errors.push(err('error', 'fail hone par error {code, message} zaroori hai'));
    }
  }
  return { ok: errors.length === 0, errors };
}

// Projection wale operations ke liye guaranteed:false ki shart (operation ka naam alag se milta hai)
function validateResultFor(operation, r) {
  const base = validateResult(r);
  const op = OPERATIONS[operation];
  const errors = base.errors.slice();
  if (!op) errors.push(err('operation', 'operation maujood nahi'));
  else if (op.projection && r && r.status === STATUS.SUCCESS && r.guaranteed !== false) {
    errors.push(err('guaranteed', 'projection ke result mein guaranteed:false likhna zaroori hai (return pakka nahi hota)'));
  }
  return { ok: errors.length === 0, errors };
}

/* ========================================================================== */
/* 5. Capability record (engine apna parichay is format mein deta hai)        */
/* ========================================================================== */

function validateCapability(c) {
  const errors = [];
  if (!isPlainObject(c)) return { ok: false, errors: [err('capability', 'object hona chahiye')] };
  if (typeof c.name !== 'string' || !/^[a-z][a-z0-9_.-]{1,40}$/.test(c.name)) errors.push(err('name', 'name chhota aur saaf ho'));
  if (!ENGINES.includes(c.technology)) errors.push(err('technology', 'technology known nahi'));
  if (typeof c.version !== 'string' || !c.version) errors.push(err('version', 'version zaroori hai'));
  if (typeof c.contract_version !== 'string' || c.contract_version.split('.')[0] !== CONTRACT_VERSION.split('.')[0]) {
    errors.push(err('contract_version', 'engine ye contract version nahi bolta'));
  }
  if (!Array.isArray(c.operations) || !c.operations.length) errors.push(err('operations', 'kam se kam ek operation zaroori'));
  else c.operations.forEach(o => { if (!OPERATIONS[o]) errors.push(err('operations', 'operation maujood nahi: ' + o)); });
  if (!Number.isFinite(c.typical_latency_ms) || c.typical_latency_ms < 0) errors.push(err('typical_latency_ms', 'latency number ho'));
  if (!Number.isInteger(c.max_job_size) || c.max_job_size < 1) errors.push(err('max_job_size', 'max_job_size poora number ho'));
  if (!COST_CLASS.includes(c.cost_class)) errors.push(err('cost_class', 'cost_class cheap/normal/heavy mein se ek'));
  if (!DEPLOYMENT.includes(c.deployment)) errors.push(err('deployment', 'deployment in-process/wasm/remote mein se ek'));
  return { ok: errors.length === 0, errors };
}

/* ========================================================================== */
/* 6. Tolerance (engines ka jawab milane ke liye)                             */
/* ========================================================================== */

// Brief: paise ki value Rs 1 ke andar mile. Percent 0.01 ke andar. Baaki bahut chhota relative farak.
const TOLERANCE = Object.freeze({ inr: 1, percent: 0.01, years: 0.0001, months: 0, count: 0, flag: 0 });

function withinTolerance(a, b, unit = 'inr') {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const tol = TOLERANCE[unit] !== undefined ? TOLERANCE[unit] : 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  return Math.abs(x - y) <= tol;
}

module.exports = {
  CONTRACT_VERSION, ENGINES, STATUS, UNITS, COST_CLASS, DEPLOYMENT, OPERATIONS, TOLERANCE,
  parseNumber, findBadNumbers,
  createTask, validateTask, createResult, validateResult, validateResultFor, validateCapability, withinTolerance
};
