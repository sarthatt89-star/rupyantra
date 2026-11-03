//! What the engine really did: counters and the last executions (function, outcome, duration; never inputs).

use crate::json::{obj, Json};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

pub const RECENT: usize = 100;

#[derive(Clone)]
pub struct Record {
    pub execution_id: String,
    pub function: String,
    pub executed: bool,
    pub success: bool,
    pub duration_ms: f64,
}

pub struct Metrics {
    started: Instant,
    total: AtomicU64,
    succeeded: AtomicU64,
    failed: AtomicU64,
    rejected: AtomicU64,
    forwarded: AtomicU64,
    forward_failed: AtomicU64,
    duration_micros: AtomicU64,
    recent: Mutex<VecDeque<Record>>,
}

impl Default for Metrics {
    fn default() -> Self {
        Metrics::new()
    }
}

impl Metrics {
    pub fn new() -> Metrics {
        Metrics {
            started: Instant::now(),
            total: AtomicU64::new(0),
            succeeded: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            rejected: AtomicU64::new(0),
            forwarded: AtomicU64::new(0),
            forward_failed: AtomicU64::new(0),
            duration_micros: AtomicU64::new(0),
            recent: Mutex::new(VecDeque::new()),
        }
    }

    pub fn record_execution(&self, r: Record) {
        self.total.fetch_add(1, Ordering::Relaxed);
        if r.success {
            self.succeeded.fetch_add(1, Ordering::Relaxed);
        } else {
            self.failed.fetch_add(1, Ordering::Relaxed);
        }
        self.duration_micros.fetch_add((r.duration_ms * 1000.0).max(0.0) as u64, Ordering::Relaxed);
        if let Ok(mut q) = self.recent.lock() {
            if q.len() >= RECENT {
                q.pop_front();
            }
            q.push_back(r);
        }
    }

    /// A request refused before any calculation started (bad token, rate limit, too large, ...).
    pub fn record_rejected(&self) {
        self.rejected.fetch_add(1, Ordering::Relaxed);
    }

    /// A request passed on to another engine. `ok` = that engine returned a verified answer (even a failure answer);
    /// not ok = it could not be reached or its answer could not be verified.
    pub fn record_forward(&self, ok: bool) {
        self.forwarded.fetch_add(1, Ordering::Relaxed);
        if !ok {
            self.forward_failed.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn snapshot(&self) -> Json {
        let total = self.total.load(Ordering::Relaxed);
        let failed = self.failed.load(Ordering::Relaxed);
        let micros = self.duration_micros.load(Ordering::Relaxed);
        let recent: Vec<Json> = self
            .recent
            .lock()
            .map(|q| {
                q.iter()
                    .rev()
                    .take(20)
                    .map(|r| {
                        obj(vec![
                            ("execution_id", Json::str(r.execution_id.clone())),
                            ("function", Json::str(r.function.clone())),
                            ("executed", Json::Bool(r.executed)),
                            ("success", Json::Bool(r.success)),
                            ("duration_ms", Json::Num(r.duration_ms)),
                        ])
                    })
                    .collect()
            })
            .unwrap_or_default();
        obj(vec![
            ("uptime_seconds", Json::Num(self.started.elapsed().as_secs_f64())),
            ("executions_total", Json::Num(total as f64)),
            ("executions_succeeded", Json::Num(self.succeeded.load(Ordering::Relaxed) as f64)),
            ("executions_failed", Json::Num(failed as f64)),
            ("requests_rejected_before_execution", Json::Num(self.rejected.load(Ordering::Relaxed) as f64)),
            ("forwarded_to_other_engines", Json::Num(self.forwarded.load(Ordering::Relaxed) as f64)),
            ("forwarding_failed", Json::Num(self.forward_failed.load(Ordering::Relaxed) as f64)),
            ("error_rate_percent", Json::opt(if total > 0 { Some(failed as f64 / total as f64 * 100.0) } else { None })),
            ("mean_duration_ms", Json::opt(if total > 0 { Some(micros as f64 / 1000.0 / total as f64) } else { None })),
            ("memory_rss_kb", Json::opt(resident_memory_kb().map(|k| k as f64))),
            ("recent_executions", Json::Arr(recent)),
        ])
    }
}

/// Resident memory of this process from /proc (Linux). None elsewhere: unknown is reported as unknown.
pub fn resident_memory_kb() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = text.lines().find(|l| l.starts_with("VmRSS:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(ok: bool, ms: f64) -> Record {
        Record { execution_id: "x".into(), function: "f".into(), executed: true, success: ok, duration_ms: ms }
    }

    #[test]
    fn counters_and_error_rate() {
        let m = Metrics::new();
        assert_eq!(m.snapshot().get("error_rate_percent"), Some(&Json::Null));
        m.record_execution(rec(true, 2.0));
        m.record_execution(rec(false, 4.0));
        m.record_rejected();
        let s = m.snapshot();
        assert_eq!(s.get("executions_total").unwrap().as_f64(), Some(2.0));
        assert_eq!(s.get("error_rate_percent").unwrap().as_f64(), Some(50.0));
        assert_eq!(s.get("mean_duration_ms").unwrap().as_f64(), Some(3.0));
        assert_eq!(s.get("requests_rejected_before_execution").unwrap().as_f64(), Some(1.0));
    }

    #[test]
    fn recent_list_is_bounded() {
        let m = Metrics::new();
        for _ in 0..(RECENT + 50) {
            m.record_execution(rec(true, 1.0));
        }
        assert_eq!(m.recent.lock().unwrap().len(), RECENT);
        assert_eq!(m.snapshot().get("recent_executions").unwrap().as_array().unwrap().len(), 20);
    }
}
