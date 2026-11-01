'use strict';

/*
 * Timing: plain-JS Monte Carlo vs the WebAssembly engine (lib/wasm/finance.wasm).
 * Run:  node cpp-engine/tests/bench.js
 * The JS version uses the same maths (log-normal monthly steps) so the work is comparable.
 * If finance.wasm does not exist the WASM rows are skipped.
 */

const path = require('node:path');
const fs = require('node:fs');
const bridge = require('../../lib/cpp-bridge');

function jsSipMonteCarlo(P, retPct, volPct, months, sims) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; };
  const normal = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const g = 1 + retPct / 1200, sig = volPct / 100 / Math.sqrt(12), mu = Math.log(g) - 0.5 * sig * sig;
  const finals = new Float64Array(sims);
  for (let s = 0; s < sims; s++) {
    let bal = 0;
    for (let m = 0; m < months; m++) bal = (bal + P) * Math.exp(mu + sig * normal());
    finals[s] = bal;
  }
  finals.sort();
  return finals[Math.floor(sims / 2)];
}

function time(fn, repeat = 3) {
  fn(); // warm-up
  let best = Infinity;
  for (let i = 0; i < repeat; i++) {
    const t = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
  }
  return best;
}

const cases = [[5000, 120], [20000, 120], [50000, 240]];
const haveWasm = fs.existsSync(path.join(__dirname, '..', '..', 'lib', 'wasm', 'finance.wasm'));
console.log('Node', process.version, haveWasm ? '| WASM found' : '| WASM not built, skipping WASM rows');
console.log('SIP Monte Carlo (monthly 10000, 12% return, 15% volatility)');
for (const [sims, months] of cases) {
  const js = time(() => jsSipMonteCarlo(10000, 12, 15, months, sims));
  let line = `  ${String(sims).padStart(6)} sims x ${String(months).padStart(3)} months: JS ${js.toFixed(1).padStart(8)} ms`;
  if (haveWasm) {
    const w = time(() => {
      const r = bridge.simulateSip({ monthly_amount: 10000, annual_return: 12, annual_volatility: 15, months, simulations: sims });
      if (!r.ok) throw new Error(r.error);
    });
    line += ` | WASM ${w.toFixed(1).padStart(8)} ms | x${(js / w).toFixed(1)} faster`;
  }
  console.log(line);
}

if (haveWasm) {
  const rows = Array.from({ length: 10000 }, (_, i) => [100000 + i, 9, 120]);
  const jsEmi = (P, r, n) => { const i = r / 1200; return P * i * Math.pow(1 + i, n) / (Math.pow(1 + i, n) - 1); };
  const js = time(() => rows.map(([P, r, n]) => jsEmi(P, r, n)));
  const w = time(() => { if (!bridge.emiBatch(rows).ok) throw new Error('batch failed'); });
  console.log(`EMI for 10,000 loans: JS ${js.toFixed(2)} ms | WASM ${w.toFixed(2)} ms (includes copying in/out)`);
}
