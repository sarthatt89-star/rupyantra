# Rupeyantra Julia engine: status report

Statuses are honest: **VERIFIED** means a green GitHub Actions run was seen. **IMPLEMENTED, NOT VERIFIED** means the code
exists but no green run has been seen yet. **NOT BUILT** means it does not exist.

| Area | What it does | Status |
|---|---|---|
| Phase A: Monte Carlo | SIP, lumpsum, SIP scenarios; chunked RNG so results do not depend on thread count | Reported green by the user |
| Phase B: Portfolio | return, volatility, correlation checks, risk contribution, diversification, Sharpe, compare | Reported green by the user (one test limit was fixed) |
| Phase C: Optimization | min variance, max Sharpe, target return, efficient frontier, goal plan, goal sensitivity | Reported green by the user (max-Sharpe fix included) |
| Phase D: Numerical / matrix / stress | matrix operations, numerical self-check, stress scenarios, volatility stress | Reported green by the user (one invalid `@test` fixed) |
| Phase E: JS bridge | `lib/julia-bridge.js`: approved names only, timeout, token, evidence check | 9 offline tests pass in the build sandbox; real-Julia test reported green by the user |
| AI routing | `aiBrief()` gives the AI text only when Julia evidence exists | Helper built; **not wired into api/chat.js** (see below) |
| Hosting of Julia | A separate HTTPS service is needed (Vercel cannot run Julia) | **NOT BUILT** |

## What is deliberately not done
- No existing production file was replaced or edited (api/chat.js, finance-engine.js, C++ files untouched).
- Nothing is pushed or deployed automatically.
- The bridge is dormant until `JULIA_SERVICE_URL` (+ `JULIA_SERVICE_TOKEN`) is set; the site then keeps using C++/JS.

## Security
- Only the 14 names in `APPROVED` can be called (checked in JS and again in Julia). No code strings are evaluated.
- Request cap 200 KB, response cap 2 MB, time cap 15 s (max 60 s), https + token required off-machine.
- Errors never include stack traces.

## Known limits
- Optimised weights are very sensitive to the input estimates; outputs are planning calculations, not advice.
- Stress scenarios use shocks the user supplies; nothing is a forecast.
- Julia speed numbers are printed in the Actions log (performance testset); none are claimed here.
