# Rupeyantra Rust engine

A secured service, a safe parallel data processor and a reliability layer that sit **in front of / next to** the other engines.
It does not repeat their work: no EMI/SIP/tax (C++), no simulation or optimisation (Julia), no forecasting, risk or anomaly
analytics (Python).

* **No third-party packages.** Standard library only (no crates are downloaded). Needs Rust 1.75 or newer
  (built and tested here with 1.97; CI uses the runner's stable toolchain).
* Nothing is invented: data is reported on, never cleaned or filled in. Every answer carries a real execution record:
  `engine, function, executed, success, execution_id, duration_ms, version`.

## Functions (the only things that can run: `src/engine.rs`)
| Function | What it does |
|---|---|
| `csv_profile` | Reads CSV text and reports columns, empty and non-numeric cells, ragged rows and exact duplicate rows. Changes nothing. |
| `batch_returns` | Return / volatility profile of up to 10,000 price series at once, computed in parallel. Same answer for any number of workers. |
| `rolling_stats` | Rolling mean and standard deviation in one pass (O(n)). |

Python-owned functions (`forecast`, `risk_report`, ...) can also be sent to this service. If `PY_SERVICE_URL` is set they are
forwarded to the Python service and its **verified answer is returned unchanged (still labelled `python`)**. If Python is not
reachable the answer is an honest `ENGINE_UNAVAILABLE` with `executed:false`: nothing is calculated in its place.
Julia and C++ are **not** reachable from here.

## Run
```
cargo build --release
echo '{"function":"rolling_stats","args":{"values":[1,2,3,4,5],"window":3}}' | ./target/release/rupeyantra-rust run
RUST_SERVICE_TOKEN=<16+ random characters> ./target/release/rupeyantra-rust serve
cargo test            # RY_PYTHON=python3 also runs the tests against the real Python service
cargo bench           # prints real timings for this machine
```

## Service
`GET /health` (open, no secrets) · `GET /metrics` (token) · `POST /run` (token, `Authorization: Bearer ...`).
Settings (environment): `RUST_SERVICE_TOKEN` (required, 16+ characters), `RUST_SERVICE_HOST` (127.0.0.1),
`RUST_SERVICE_PORT` (8081), `RUST_TIMEOUT_SECONDS` (20, max 60), `RUST_RATE_PER_MINUTE` (120), `RUST_MAX_BODY_BYTES`
(2,000,000, max 5,000,000), `RUST_MAX_CONNECTIONS` (64), `RUST_WORKERS` (CPU count, max 8), `PY_SERVICE_URL` and
`PY_SERVICE_TOKEN` (optional, Python service).
It refuses to start without a strong token or with an invalid Python address.

Protection: constant-time token check, header size and time limits, body size checked **before** the body is read, per-client
rate limit, connection limit, approved names only, deadline, panic containment, and an audit log with fixed fields
(it cannot contain request bodies or tokens).

**Limits to know:** there is no TLS (the standard library has none): run it on a private network or behind a TLS-terminating
proxy. The deadline is cooperative: a calculation is stopped at its next check, not in the middle of an instruction. The
Python connector uses plain `http://` and only to loopback or private-network addresses.

## From JavaScript
`lib/rust-bridge.js` (`RUST_SERVICE_URL` + `RUST_SERVICE_TOKEN`, or `RY_RUST=/path/to/binary` for development). If neither is
set the bridge answers `ENGINE_UNAVAILABLE`, and nothing may claim that Rust was used.
