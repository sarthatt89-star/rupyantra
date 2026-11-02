# Rupeyantra Python engine

Data analysis, risk analysis, portfolio analysis, forecasting and anomaly detection on **data you supply**.
It runs next to the C++ engine (deterministic calculators), the Julia engine (simulation, optimisation) and the
JavaScript site/API. It does not repeat their work: there is no EMI, SIP, tax, Monte Carlo or optimisation here.

* Needs Python 3.10 or newer (CI runs 3.10 and 3.12; the build environment tested 3.13).
* No third-party runtime packages (standard library only). `requirements-dev.txt` is for tests only.
* Nothing is invented: missing data is reported, never filled; every answer is analysis of the supplied history or of
  assumptions you state; forecasts are never promises.
* Every answer carries a real execution record: `engine, function, executed, success, execution_id, duration_ms, version`.

## Functions (all in `src/engine.py`)
`describe_series, batch_describe, price_analysis, correlation_analysis, max_drawdown, value_at_risk, worst_windows,
risk_report, portfolio_analysis, forecast, backtest_forecast, scenario_projection, detect_anomalies`

## Run
```
echo '{"function":"describe_series","args":{"values":[1,2,3,4,5]}}' | python3 run.py     # command line
PY_SERVICE_TOKEN=<16+ random characters> python3 server.py                               # secured HTTP service
python3 -m pytest -q                                                                     # tests (pip install -r requirements-dev.txt)
```

## Service (server.py)
`GET /health`, `POST /run` with `Authorization: Bearer <token>`. Settings (environment): `PY_SERVICE_TOKEN` (required, 16+
characters), `PY_SERVICE_HOST` (127.0.0.1), `PY_SERVICE_PORT` (8080), `PY_TIMEOUT_SECONDS` (20, max 60),
`PY_RATE_PER_MINUTE` (60), `PY_MAX_BODY_BYTES` (2,000,000, max 5,000,000). It refuses to start without a strong token.
It is **not deployed automatically**; it needs a host that can run a Python process, behind HTTPS.

## From JavaScript
`lib/python-bridge.js` (`PY_SERVICE_URL` + `PY_SERVICE_TOKEN`, or `RY_PYTHON` for local development). If neither is set the
bridge answers `ENGINE_UNAVAILABLE` and nothing may claim that Python was used.
