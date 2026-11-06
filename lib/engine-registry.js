'use strict';

/*
 * Rupeyantra Engine Registry (lib/engine-registry.js)  --  PHASE 2
 *
 * Har engine (JS, C++, Python, Julia, Rust, SQL) yahan apna "capability record" aur ek adapter ke saath register hota hai.
 * Adapter = { capability, run(task, ctx) }:
 *   - capability : lib/contracts.js ka validateCapability() jisse pass ho
 *   - run(task, { signal, deadlineAt }) : task (validated, contract format) leta hai aur lautata hai
 *       { result: {...}, assumptions: [...], engine_version?, units?, warnings?, source_refs? }
 *     Fail hone par throw karta hai (error-handler ke AppError ya normal Error). signal abort ho to kaam rok de.
 * Registry sirf yaad rakhti hai: koi network ya engine nahi chhoti.
 */

const contracts = require('./contracts');

function createRegistry() {
  const entries = new Map();

  function register(adapter) {
    if (!adapter || typeof adapter !== 'object' || typeof adapter.run !== 'function') {
      throw new Error('adapter mein run() function zaroori hai');
    }
    const v = contracts.validateCapability(adapter.capability);
    if (!v.ok) throw new Error('capability galat hai: ' + v.errors.map(e => e.field + ' - ' + e.message).join('; '));
    const name = adapter.capability.name;
    if (entries.has(name)) throw new Error('is naam ka engine pehle se registered hai: ' + name);
    entries.set(name, adapter);
    return name;
  }

  const get = name => entries.get(name) || null;
  const list = () => [...entries.values()];
  const supporting = operation => list().filter(a => a.capability.operations.includes(operation));

  return { register, get, list, supporting, size: () => entries.size };
}

module.exports = { createRegistry };
