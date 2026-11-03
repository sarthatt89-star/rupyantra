//! The secured HTTP service (standard library only; one thread per connection, with a hard connection limit).
//!
//!   GET  /health   no token, no secrets, no calculation
//!   GET  /metrics  needs the token: counters and the last executions (never inputs)
//!   POST /run      needs the token. Body {"function": "...", "args": {...}}
//!                  Rust-owned functions run here. Python-owned functions are forwarded to the Python service, if one is
//!                  configured, and its verified answer is returned unchanged. Anything else is refused.
//!
//! Protection: bearer token (constant-time), header size/time limits, body size limit checked BEFORE the body is read,
//! per-client rate limit, connection limit, execution deadline, approved names only, and an audit log with fixed fields.
//! TLS is not provided (standard library has none): run it on a private network or behind a TLS-terminating proxy.

use super::service_connector::PythonConnector;
use crate::computing::Deadline;
use crate::config::Settings;
use crate::engine::{self, Ctx, Outcome};
use crate::errors::{Code, EngineError};
use crate::json::{self, obj, Json};
use crate::monitoring::{Metrics, Record};
use crate::router::{self, Owner};
use crate::security::{bearer_matches, AuditEvent, AuditLog, RateLimiter};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_HEAD_BYTES: usize = 16 * 1024;
const MAX_HEADERS: usize = 64;

pub struct App {
    pub settings: Settings,
    pub metrics: Metrics,
    pub audit: AuditLog,
    pub head_timeout: Duration,
    limiter: Mutex<RateLimiter>,
    connector: Option<PythonConnector>,
    active: AtomicUsize,
}

impl App {
    pub fn new(settings: Settings, audit: AuditLog) -> Result<App, EngineError> {
        let connector = match &settings.python_url {
            Some(url) => Some(PythonConnector::new(url, settings.python_token.clone(), Duration::from_secs_f64(settings.timeout_seconds))?),
            None => None,
        };
        let limiter = Mutex::new(RateLimiter::new(settings.rate_per_minute, Duration::from_secs(60)));
        Ok(App { settings, metrics: Metrics::new(), audit, head_timeout: Duration::from_secs(10), limiter, connector, active: AtomicUsize::new(0) })
    }
}

struct Head {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    content_length: Option<usize>,
    leftover: Vec<u8>,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

struct HttpFail {
    status: u16,
    message: &'static str,
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    }
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        reason(status),
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn respond_json(stream: &mut TcpStream, status: u16, v: &Json) {
    respond(stream, status, &json::to_string(v).unwrap_or_else(|_| "{\"ok\":false}".into()));
}

fn simple_error(message: &str) -> Json {
    obj(vec![("ok", Json::Bool(false)), ("error", Json::str(message))])
}

fn read_head(stream: &mut TcpStream, limit: Duration) -> Result<Head, HttpFail> {
    let start = Instant::now();
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEAD_BYTES {
            return Err(HttpFail { status: 431, message: "request headers are too large" });
        }
        let left = limit.checked_sub(start.elapsed()).filter(|d| !d.is_zero()).ok_or(HttpFail { status: 408, message: "request took too long" })?;
        let _ = stream.set_read_timeout(Some(left));
        match stream.read(&mut chunk) {
            Ok(0) => return Err(HttpFail { status: 400, message: "connection closed before the request was complete" }),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                return Err(HttpFail { status: 408, message: "request took too long" })
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(HttpFail { status: 400, message: "could not read the request" }),
        }
    };
    if end > MAX_HEAD_BYTES {
        return Err(HttpFail { status: 431, message: "request headers are too large" });
    }
    let bad = |message| HttpFail { status: 400, message };
    let text = std::str::from_utf8(&buf[..end]).map_err(|_| bad("headers are not valid text"))?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target, version) = (first.next().unwrap_or(""), first.next().unwrap_or(""), first.next().unwrap_or(""));
    if method.is_empty() || target.is_empty() || !version.starts_with("HTTP/1.") || first.next().is_some() {
        return Err(bad("malformed request line"));
    }
    let mut headers = Vec::new();
    let mut content_length: Option<usize> = None;
    for line in lines {
        if headers.len() >= MAX_HEADERS {
            return Err(HttpFail { status: 431, message: "too many headers" });
        }
        let (k, v) = line.split_once(':').ok_or_else(|| bad("malformed header"))?;
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_string());
        if k.is_empty() || k.bytes().any(|b| b <= b' ') {
            return Err(bad("malformed header"));
        }
        match k.as_str() {
            "transfer-encoding" => return Err(HttpFail { status: 501, message: "chunked or encoded bodies are not supported" }),
            "content-length" => {
                let n = v.parse::<usize>().map_err(|_| bad("bad Content-Length"))?;
                if content_length.replace(n).is_some() {
                    return Err(bad("duplicate Content-Length"));
                }
            }
            _ => {}
        }
        headers.push((k, v));
    }
    Ok(Head {
        method: method.to_string(),
        path: target.split('?').next().unwrap_or("").to_string(),
        headers,
        content_length,
        leftover: buf[end + 4..].to_vec(),
    })
}

fn read_body(stream: &mut TcpStream, mut have: Vec<u8>, want: usize, limit: Duration) -> Result<Vec<u8>, HttpFail> {
    let start = Instant::now();
    if have.len() > want {
        have.truncate(want);
    }
    let mut chunk = [0u8; 16 * 1024];
    while have.len() < want {
        let left = limit.checked_sub(start.elapsed()).filter(|d| !d.is_zero()).ok_or(HttpFail { status: 408, message: "request took too long" })?;
        let _ = stream.set_read_timeout(Some(left));
        let take = (want - have.len()).min(chunk.len());
        match stream.read(&mut chunk[..take]) {
            Ok(0) => return Err(HttpFail { status: 400, message: "connection closed before the body was complete" }),
            Ok(n) => have.extend_from_slice(&chunk[..n]),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                return Err(HttpFail { status: 408, message: "request took too long" })
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(HttpFail { status: 400, message: "could not read the request body" }),
        }
    }
    Ok(have)
}

fn audit(app: &App, event: &'static str, status: u16, function: Option<&str>, t0: Instant, id: Option<&str>) {
    app.audit.record(&AuditEvent { event, status, function, duration_ms: t0.elapsed().as_secs_f64() * 1000.0, execution_id: id });
}

fn handle(app: &App, mut stream: TcpStream) {
    let t0 = Instant::now();
    let client = stream.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let head = match read_head(&mut stream, app.head_timeout) {
        Ok(h) => h,
        Err(f) => {
            app.metrics.record_rejected();
            audit(app, "bad_request", f.status, None, t0, None);
            return respond_json(&mut stream, f.status, &simple_error(f.message));
        }
    };
    let authorized = bearer_matches(head.header("authorization"), &app.settings.token);
    match (head.method.as_str(), head.path.as_str()) {
        ("GET", "/health") => {
            let mut info = match engine::info() {
                Json::Obj(items) => items,
                _ => vec![],
            };
            info.insert(0, ("ok".into(), Json::Bool(true)));
            info.push(("python_forwarding_configured".into(), Json::Bool(app.connector.is_some())));
            info.push(("timeout_kind".into(), Json::str("cooperative: calculations check the deadline between units of work")));
            respond_json(&mut stream, 200, &Json::Obj(info));
        }
        ("GET", "/metrics") => {
            if !authorized {
                app.metrics.record_rejected();
                audit(app, "auth_failed", 401, None, t0, None);
                return respond_json(&mut stream, 401, &simple_error("unauthorized"));
            }
            respond_json(&mut stream, 200, &app.metrics.snapshot());
        }
        ("POST", "/run") => run(app, stream, head, &client, authorized, t0),
        (_, "/health") | (_, "/metrics") | (_, "/run") => respond_json(&mut stream, 405, &simple_error("method not allowed")),
        _ => respond_json(&mut stream, 404, &simple_error("not found")),
    }
}

fn reject(app: &App, stream: &mut TcpStream, event: &'static str, status: u16, e: &EngineError, t0: Instant) {
    app.metrics.record_rejected();
    audit(app, event, status, None, t0, None);
    respond(stream, status, &engine::failure(None, e, false).body);
}

fn run(app: &App, mut stream: TcpStream, head: Head, client: &str, authorized: bool, t0: Instant) {
    if !authorized {
        app.metrics.record_rejected();
        audit(app, "auth_failed", 401, None, t0, None);
        return respond_json(&mut stream, 401, &simple_error("unauthorized"));
    }
    if !app.limiter.lock().map(|mut l| l.allow(client, Instant::now())).unwrap_or(false) {
        return reject(app, &mut stream, "rate_limited", 429, &EngineError::new(Code::RateLimited, "too many requests; try again shortly"), t0);
    }
    let Some(length) = head.content_length else {
        return reject(app, &mut stream, "bad_request", 400, &EngineError::new(Code::BadRequest, "Content-Length is required"), t0);
    };
    if length > app.settings.max_body_bytes {
        return reject(app, &mut stream, "too_large", 413, &EngineError::new(Code::TooLarge, "request is too large"), t0);
    }
    let body = match read_body(&mut stream, head.leftover, length, app.head_timeout.max(Duration::from_secs(10))) {
        Ok(b) => b,
        Err(f) => return reject(app, &mut stream, "bad_request", f.status, &EngineError::new(Code::BadRequest, f.message), t0),
    };
    let parsed = std::str::from_utf8(&body).ok().and_then(|t| json::parse(t).ok());
    let Some(req) = parsed else {
        return reject(app, &mut stream, "bad_request", 200, &EngineError::new(Code::BadRequest, "request is not valid JSON"), t0);
    };

    let name = req.get("function").and_then(Json::as_str).unwrap_or("");
    if router::route(name) == Owner::Python {
        return forward(app, &mut stream, name, &req, t0);
    }

    let ctx = Ctx { deadline: Deadline::after(Duration::from_secs_f64(app.settings.timeout_seconds)), workers: app.settings.workers };
    let out: Outcome = engine::execute_parsed(&req, &ctx);
    let status = if out.error_code == Some(Code::Timeout) { 504 } else { 200 };
    if out.executed {
        app.metrics.record_execution(Record {
            execution_id: out.execution_id.clone(),
            function: out.function.unwrap_or("-").to_string(),
            executed: true,
            success: out.success,
            duration_ms: out.duration_ms,
        });
    } else {
        app.metrics.record_rejected();
    }
    audit(app, "run", status, out.function, t0, Some(&out.execution_id));
    respond(&mut stream, status, &out.body);
}

fn forward(app: &App, stream: &mut TcpStream, name: &str, req: &Json, t0: Instant) {
    let approved = router::PYTHON_FUNCTIONS.iter().copied().find(|f| *f == name);
    let args = match req.get("args") {
        None | Some(Json::Null) => None,
        Some(a) => Some(a),
    };
    let Some(connector) = &app.connector else {
        app.metrics.record_forward(false);
        audit(app, "forward_unavailable", 503, approved, t0, None);
        let e = EngineError::new(Code::EngineUnavailable, "the Python engine is not configured on this service; nothing was calculated");
        return respond(stream, 503, &engine::failure(Some(name), &e, false).body);
    };
    match connector.call(name, args) {
        Ok(f) => {
            app.metrics.record_forward(true);
            audit(app, "forward", f.status, approved, t0, None);
            respond(stream, f.status, &f.body); // Python's own answer, unchanged
        }
        Err(e) => {
            app.metrics.record_forward(false);
            let status = if e.code == Code::Timeout { 504 } else { 503 };
            audit(app, "forward_failed", status, approved, t0, None);
            respond(stream, status, &engine::failure(Some(name), &e, false).body);
        }
    }
}

struct Slot<'a>(&'a AtomicUsize);
impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Accept connections until `stop` is set, then wait (up to 5 s) for running requests to finish.
pub fn serve(listener: TcpListener, app: Arc<App>, stop: Arc<AtomicBool>) -> std::io::Result<()> {
    listener.set_nonblocking(true)?;
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                if app.active.fetch_add(1, Ordering::SeqCst) >= app.settings.max_connections {
                    app.active.fetch_sub(1, Ordering::SeqCst);
                    app.metrics.record_rejected();
                    let e = EngineError::new(Code::RateLimited, "the service is busy; try again shortly");
                    respond(&mut stream, 503, &engine::failure(None, &e, false).body);
                    continue;
                }
                let app = app.clone();
                std::thread::spawn(move || {
                    let _slot = Slot(&app.active);
                    handle(&app, stream);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let wait = Instant::now();
    while app.active.load(Ordering::SeqCst) > 0 && wait.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    const TOKEN: &str = "unit-test-token-0123456789";

    pub struct Running {
        pub addr: SocketAddr,
        stop: Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for Running {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }

    fn start(tweak: impl FnOnce(&mut Settings, &mut App)) -> Running {
        let mut s = Settings::from_lookup(&|k| (k == "RUST_SERVICE_TOKEN").then(|| TOKEN.to_string())).unwrap();
        let sink: Box<dyn Write + Send> = Box::new(std::io::sink());
        s.workers = 2;
        let mut app = App::new(s.clone(), AuditLog::new(sink)).unwrap();
        let mut s2 = s;
        tweak(&mut s2, &mut app);
        let mut app = app;
        app.settings = s2;
        app.limiter = Mutex::new(RateLimiter::new(app.settings.rate_per_minute, Duration::from_secs(60)));
        let app = Arc::new(app);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let (a, st) = (app.clone(), stop.clone());
        let handle = std::thread::spawn(move || {
            serve(listener, a, st).unwrap();
        });
        Running { addr, stop, handle: Some(handle) }
    }

    fn raw(addr: SocketAddr, request: &[u8]) -> (u16, String) {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(request).unwrap();
        let mut out = Vec::new();
        let _ = s.read_to_end(&mut out);
        let text = String::from_utf8_lossy(&out).to_string();
        let status = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        (status, text.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
    }

    fn post(addr: SocketAddr, token: Option<&str>, body: &str) -> (u16, Json) {
        let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
        let req = format!("POST /run HTTP/1.1\r\nHost: x\r\n{auth}Content-Length: {}\r\n\r\n{body}", body.len());
        let (s, b) = raw(addr, req.as_bytes());
        (s, json::parse(&b).unwrap_or(Json::Null))
    }

    fn err_code(v: &Json) -> String {
        v.get("error").and_then(|e| e.get("code")).and_then(Json::as_str).unwrap_or("").to_string()
    }

    const RUN: &str = "{\"function\":\"rolling_stats\",\"args\":{\"values\":[1,2,3,4,5],\"window\":3}}";

    #[test]
    fn health_is_open_and_leaks_nothing() {
        let r = start(|_, _| {});
        let (s, b) = raw(r.addr, b"GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
        assert_eq!(s, 200);
        assert!(b.contains("\"engine\":\"rust\"") && b.contains("rolling_stats") && !b.contains(TOKEN));
        assert_eq!(raw(r.addr, b"GET /nothing HTTP/1.1\r\n\r\n").0, 404);
        assert_eq!(raw(r.addr, b"DELETE /run HTTP/1.1\r\n\r\n").0, 405);
    }

    #[test]
    fn run_needs_the_exact_token() {
        let r = start(|_, _| {});
        for t in [None, Some("wrong-token-0123456789"), Some(&format!("{TOKEN}x")[..])] {
            assert_eq!(post(r.addr, t, RUN).0, 401);
        }
        let (s, v) = post(r.addr, Some(TOKEN), RUN);
        assert_eq!(s, 200);
        assert_eq!(v.get("success").unwrap().as_bool(), Some(true));
        assert_eq!(v.get("engine").unwrap().as_str(), Some("rust"));
        assert_eq!(v.get("execution_id").unwrap().as_str().unwrap().len(), 32);
        assert_eq!(raw(r.addr, b"GET /metrics HTTP/1.1\r\n\r\n").0, 401);
    }

    #[test]
    fn honest_failures() {
        let r = start(|_, _| {});
        let (s, v) = post(r.addr, Some(TOKEN), "{\"function\":\"eval\",\"args\":{}}");
        assert_eq!((s, err_code(&v).as_str(), v.get("executed").unwrap().as_bool()), (200, "NOT_APPROVED", Some(false)));
        let (s, v) = post(r.addr, Some(TOKEN), "{broken");
        assert_eq!((s, err_code(&v).as_str()), (200, "BAD_REQUEST"));
        let (_, v) = post(r.addr, Some(TOKEN), "{\"function\":\"rolling_stats\",\"args\":{\"values\":[1,null,3],\"window\":2}}");
        assert_eq!((err_code(&v).as_str(), v.get("executed").unwrap().as_bool()), ("INVALID_INPUT", Some(true)));
        let (s, v) = post(r.addr, Some(TOKEN), "\u{1}\u{2}");
        assert_eq!((s, err_code(&v).as_str()), (200, "BAD_REQUEST"));
    }

    #[test]
    fn oversized_body_is_refused_before_it_is_read() {
        let r = start(|s, _| s.max_body_bytes = 1000);
        // only the headers are sent; the 413 must arrive without any body bytes
        let (s, b) = raw(r.addr, format!("POST /run HTTP/1.1\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: 999999\r\n\r\n").as_bytes());
        assert_eq!(s, 413);
        assert!(b.contains("TOO_LARGE") && b.contains("\"executed\":false"));
        assert_eq!(post(r.addr, Some(TOKEN), RUN).0, 200, "still serving");
    }

    #[test]
    fn missing_or_conflicting_lengths_and_chunked_bodies_are_refused() {
        let r = start(|_, _| {});
        let a = format!("Authorization: Bearer {TOKEN}\r\n");
        assert_eq!(raw(r.addr, format!("POST /run HTTP/1.1\r\n{a}\r\n").as_bytes()).0, 400);
        assert_eq!(raw(r.addr, format!("POST /run HTTP/1.1\r\n{a}Content-Length: 1\r\nContent-Length: 1\r\n\r\nx").as_bytes()).0, 400);
        assert_eq!(raw(r.addr, format!("POST /run HTTP/1.1\r\n{a}Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n").as_bytes()).0, 501);
        assert_eq!(raw(r.addr, format!("POST /run HTTP/1.1\r\n{a}Content-Length: abc\r\n\r\n").as_bytes()).0, 400);
        assert_eq!(raw(r.addr, b"GARBAGE\r\n\r\n").0, 400);
        let many: String = (0..80).map(|i| format!("X-{i}: y\r\n")).collect();
        assert_eq!(raw(r.addr, format!("GET /health HTTP/1.1\r\n{many}\r\n").as_bytes()).0, 431);
        let huge = "a".repeat(20_000);
        assert_eq!(raw(r.addr, format!("GET /health HTTP/1.1\r\nX: {huge}\r\n\r\n").as_bytes()).0, 431);
        assert_eq!(post(r.addr, Some(TOKEN), RUN).0, 200, "still serving");
    }

    #[test]
    fn rate_limit_applies_to_run_only() {
        let r = start(|s, _| s.rate_per_minute = 3);
        let codes: Vec<u16> = (0..5).map(|_| post(r.addr, Some(TOKEN), RUN).0).collect();
        assert_eq!(codes, vec![200, 200, 200, 429, 429]);
        assert_eq!(raw(r.addr, b"GET /health HTTP/1.1\r\n\r\n").0, 200);
    }

    #[test]
    fn slow_clients_are_cut_off() {
        let r = start(|_, a| a.head_timeout = Duration::from_millis(300));
        let t0 = Instant::now();
        let mut s = TcpStream::connect(r.addr).unwrap();
        s.write_all(b"POST /run HTTP/1.1\r\nHost: x").unwrap(); // never finishes the headers
        let mut out = String::new();
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = s.read_to_string(&mut out);
        assert!(out.starts_with("HTTP/1.1 408"), "{out}");
        assert!(t0.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn connection_limit_answers_503() {
        let r = start(|s, a| {
            s.max_connections = 2;
            a.head_timeout = Duration::from_millis(1500);
        });
        let _idle: Vec<TcpStream> = (0..2).map(|_| TcpStream::connect(r.addr).unwrap()).collect();
        std::thread::sleep(Duration::from_millis(150));
        let (s, b) = raw(r.addr, b"GET /health HTTP/1.1\r\n\r\n");
        assert_eq!(s, 503, "{b}");
    }

    #[test]
    fn deadline_gives_504_and_the_service_keeps_working() {
        let r = start(|s, _| s.timeout_seconds = 0.0005);
        let sets: String = (0..3000).map(|i| format!("\"s{i}\":[1,2,3,4,5,6,7,8,9,10]")).collect::<Vec<_>>().join(",");
        let (s, v) = post(r.addr, Some(TOKEN), &format!("{{\"function\":\"batch_returns\",\"args\":{{\"datasets\":{{{sets}}}}}}}"));
        assert_eq!(s, 504);
        assert_eq!(err_code(&v), "TIMEOUT");
        assert_eq!((v.get("executed").unwrap().as_bool(), v.get("success").unwrap().as_bool()), (Some(true), Some(false)));
    }

    #[test]
    fn python_functions_are_unavailable_without_a_python_service_and_nothing_is_invented() {
        let r = start(|_, _| {});
        let (s, v) = post(r.addr, Some(TOKEN), "{\"function\":\"forecast\",\"args\":{\"values\":[1,2,3,4,5,6]}}");
        assert_eq!(s, 503);
        assert_eq!(err_code(&v), "ENGINE_UNAVAILABLE");
        assert_eq!(v.get("executed").unwrap().as_bool(), Some(false));
        assert!(v.get("result").is_none());
    }

    #[test]
    fn metrics_and_audit_never_contain_inputs() {
        let r = start(|_, _| {});
        post(r.addr, Some(TOKEN), "{\"function\":\"csv_profile\",\"args\":{\"csv\":\"secret_marker_777\\n12345.678\"}}");
        post(r.addr, Some("wrong-token-0123456789"), RUN);
        let (s, body) = raw(r.addr, format!("GET /metrics HTTP/1.1\r\nAuthorization: Bearer {TOKEN}\r\n\r\n").as_bytes());
        assert_eq!(s, 200);
        assert!(body.contains("csv_profile") && body.contains("\"executions_total\":1") && body.contains("\"requests_rejected_before_execution\":1"));
        assert!(!body.contains("secret_marker_777") && !body.contains("12345.678") && !body.contains(TOKEN));
    }
}
