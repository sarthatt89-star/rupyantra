//! Request protection: constant-time token check, per-client rate limit and a redacting audit log.
//!
//! The audit log can only record a fixed set of fields (see `AuditEvent`). There is no field that could hold a request
//! body, a token or a user's numbers, so they cannot leak into logs by accident.

use crate::json::{self, Json};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Compares two byte strings without stopping at the first difference.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u64;
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= (x ^ y) as u64;
    }
    diff == 0
}

/// `Authorization: Bearer <token>` must match exactly.
pub fn bearer_matches(header: Option<&str>, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    constant_time_eq(header.unwrap_or("").as_bytes(), expected.as_bytes())
}

/* ---------------- rate limiter ---------------- */

pub const MAX_TRACKED_CLIENTS: usize = 10_000;

pub struct RateLimiter {
    limit: usize,
    window: Duration,
    hits: HashMap<String, VecDeque<Instant>>,
}

impl RateLimiter {
    pub fn new(limit: usize, window: Duration) -> RateLimiter {
        RateLimiter { limit: limit.max(1), window, hits: HashMap::new() }
    }

    /// True if this request may proceed. When too many different clients are tracked the limiter fails CLOSED (refuses
    /// new clients) instead of growing without limit.
    pub fn allow(&mut self, client: &str, now: Instant) -> bool {
        if !self.hits.contains_key(client) && self.hits.len() >= MAX_TRACKED_CLIENTS {
            let window = self.window;
            self.hits.retain(|_, q| q.back().is_some_and(|t| now.saturating_duration_since(*t) <= window));
            if self.hits.len() >= MAX_TRACKED_CLIENTS {
                return false;
            }
        }
        let q = self.hits.entry(client.to_string()).or_default();
        while q.front().is_some_and(|t| now.saturating_duration_since(*t) > self.window) {
            q.pop_front();
        }
        if q.len() >= self.limit {
            return false;
        }
        q.push_back(now);
        true
    }
}

/* ---------------- audit log ---------------- */

pub struct AuditEvent<'a> {
    pub event: &'static str,
    pub status: u16,
    /// Only an approved function name; anything else must be passed as None so user text never reaches the log.
    pub function: Option<&'a str>,
    pub duration_ms: f64,
    pub execution_id: Option<&'a str>,
}

pub struct AuditLog {
    sink: Mutex<Box<dyn Write + Send>>,
}

impl AuditLog {
    pub fn new(sink: Box<dyn Write + Send>) -> AuditLog {
        AuditLog { sink: Mutex::new(sink) }
    }
    pub fn to_stderr() -> AuditLog {
        AuditLog::new(Box::new(std::io::stderr()))
    }

    pub fn record(&self, e: &AuditEvent) {
        let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
        let line = json::to_string(&json::obj(vec![
            ("ts_unix_ms", Json::Num(ts)),
            ("event", Json::str(e.event)),
            ("status", Json::Num(e.status as f64)),
            ("function", e.function.map(Json::str).unwrap_or(Json::Null)),
            ("duration_ms", Json::Num(if e.duration_ms.is_finite() { e.duration_ms } else { 0.0 })),
            ("execution_id", e.execution_id.map(Json::str).unwrap_or(Json::Null)),
        ]))
        .unwrap_or_else(|_| "{\"event\":\"audit_error\"}".to_string());
        if let Ok(mut w) = self.sink.lock() {
            let _ = writeln!(w, "{line}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn token_comparison() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"", b"a"));
        assert!(constant_time_eq(b"", b""));
        assert!(bearer_matches(Some("Bearer s3cret-token-0000"), "s3cret-token-0000"));
        for bad in [None, Some(""), Some("s3cret-token-0000"), Some("Bearer s3cret-token-0000x"), Some("bearer s3cret-token-0000")] {
            assert!(!bearer_matches(bad, "s3cret-token-0000"), "{bad:?}");
        }
    }

    #[test]
    fn rate_limit_window() {
        let mut r = RateLimiter::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(r.allow("a", t0) && r.allow("a", t0) && r.allow("a", t0));
        assert!(!r.allow("a", t0));
        assert!(r.allow("b", t0), "another client is unaffected");
        assert!(r.allow("a", t0 + Duration::from_secs(61)), "window moved on");
    }

    #[test]
    fn rate_limiter_memory_is_bounded() {
        let mut r = RateLimiter::new(5, Duration::from_secs(60));
        let t0 = Instant::now();
        for i in 0..MAX_TRACKED_CLIENTS {
            assert!(r.allow(&format!("c{i}"), t0));
        }
        assert!(!r.allow("one-more-client", t0), "fails closed instead of growing");
        assert!(r.allow("one-more-client", t0 + Duration::from_secs(120)), "old clients are forgotten");
    }

    struct Shared(Arc<Mutex<Vec<u8>>>);
    impl Write for Shared {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn audit_log_is_json_lines_with_fixed_fields() {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let log = AuditLog::new(Box::new(Shared(buf.clone())));
        log.record(&AuditEvent { event: "run", status: 200, function: Some("rolling_stats"), duration_ms: 1.5, execution_id: Some("ab") });
        log.record(&AuditEvent { event: "auth_failed", status: 401, function: None, duration_ms: f64::NAN, execution_id: None });
        let text = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        let first = json::parse(lines[0]).unwrap();
        assert_eq!(first.get("function").unwrap().as_str(), Some("rolling_stats"));
        assert_eq!(json::parse(lines[1]).unwrap().get("duration_ms").unwrap().as_f64(), Some(0.0));
    }
}
