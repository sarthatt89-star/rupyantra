'use strict';

const fs = require('node:fs');

const file = process.argv[2] || 'lib/wasm/finance.wasm';

(async () => {
  const mod = await WebAssembly.compile(fs.readFileSync(file));

  const imports = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] = imports[imp.module] || {};
    imports[imp.module][imp.name] = () => 0;
  }

  const { exports: e } = await WebAssembly.instantiate(mod, imports);
  if (typeof e._initialize === 'function') e._initialize();

  const read = () => Array.from(new Float64Array(e.memory.buffer, e.rupeyantra_result_ptr(), e.rupeyantra_result_len()));
  const fail = msg => { console.error('WASM smoke test FAILED: ' + msg); process.exit(1); };

  if (e.rupeyantra_sip_monte_carlo(10000, 12, 0, 120, 1000, 1) !== 0) fail('zero-vol call returned an error');
  const det = read();
  if (Math.abs(det[2] - 2323390.7635) > 0.01) fail('zero-vol median ' + det[2] + ' != 2323390.76');
  if (Math.abs(det[0] - 1200000) > 1e-6) fail('invested ' + det[0] + ' != 1200000');

  if (e.rupeyantra_sip_monte_carlo(10000, 12, 15, 120, 20000, 42) !== 0) fail('vol call returned an error');
  const r = read();
  if (!(r[6] <= r[1] && r[1] <= r[2] && r[2] <= r[3] && r[3] <= r[7])) fail('percentiles out of order');

  if (e.rupeyantra_sip_monte_carlo(-1, 12, 15, 120, 1000, 1) !== 1) fail('bad amount was not rejected');

  console.log('WASM smoke test passed (p10/p50/p90 = ' + r[1].toFixed(0) + ' / ' + r[2].toFixed(0) + ' / ' + r[3].toFixed(0) + ')');
})().catch(err => { console.error('WASM smoke test crashed: ' + (err && err.message)); process.exit(1); });
