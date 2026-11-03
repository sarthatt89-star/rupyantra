# Audit before the Rust engine (what was actually checked)

Repository copy available in the build environment. Files that `api/chat.js` requires but which are not in this copy could not be inspected.

| Question | Finding |
|---|---|
| Existing Rust code? | None. `rust-engine/` did not exist. |
| Is Rust installed to compile and test? | Yes (cargo/rustc 1.97 in the build environment). |
| Can crates be downloaded? | No: crates.io is not reachable from the build environment. The engine therefore uses only the standard library. |
| Vercel | No `vercel.json` / `package.json` in this copy. A persistent Rust process is **not** assumed to be possible on Vercel serverless; the service needs a host that can run a process. |
| Database / storage | Not audited (no schema or connection code in this copy). **No database code was written**, as the spec requires an audit first. |
| Other engines | C++ runs in-process in JavaScript (WASM), so Rust cannot call it over a network. The Julia service speaks a different protocol and does not exist yet. Only the Python service is reachable, and it was tested for real. |
| Wired into `api/chat.js`? | **No.** Nothing in `api/chat.js` mentions Rust, Julia or Python. |

## Deliberately not built (with reasons)
background job queue, scheduler, retry manager, database/repository/cache/connection pool, compression, secret manager,
runtime/health modules as separate files. Reasons: no job or storage requirement exists yet, the database architecture is
unaudited, and empty or speculative modules were forbidden. The retry rule that does exist: at most one retry, only when the
connection to Python could not even be opened.
