//! Settings come from environment variables. Defaults are safe; limits are clamped; a missing or weak token stops startup.

use crate::errors::{Code, EngineError, Result};

pub const MIN_TOKEN_LEN: usize = 16;

#[derive(Debug, Clone)]
pub struct Settings {
    pub token: String,
    pub host: String,
    pub port: u16,
    pub timeout_seconds: f64,
    pub rate_per_minute: usize,
    pub max_body_bytes: usize,
    pub max_connections: usize,
    pub workers: usize,
    /// Optional Python service this engine may forward to (http only, private network or loopback).
    pub python_url: Option<String>,
    pub python_token: Option<String>,
}

fn number(get: &dyn Fn(&str) -> Option<String>, name: &str, default: f64, lo: f64, hi: f64) -> f64 {
    let v = get(name).and_then(|s| s.trim().parse::<f64>().ok()).filter(|v| v.is_finite()).unwrap_or(default);
    v.clamp(lo, hi)
}

impl Settings {
    /// `get` looks a variable up (in production: the process environment; in tests: a fixed map).
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> Result<Settings> {
        let token = get("RUST_SERVICE_TOKEN").unwrap_or_default();
        if token.len() < MIN_TOKEN_LEN {
            return Err(EngineError::new(
                Code::BadRequest,
                format!("RUST_SERVICE_TOKEN must be set and at least {MIN_TOKEN_LEN} characters long"),
            ));
        }
        let default_workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).min(8) as f64;
        Ok(Settings {
            token,
            host: get("RUST_SERVICE_HOST").filter(|h| !h.trim().is_empty()).unwrap_or_else(|| "127.0.0.1".into()),
            port: number(get, "RUST_SERVICE_PORT", 8081.0, 0.0, 65535.0) as u16,
            timeout_seconds: number(get, "RUST_TIMEOUT_SECONDS", 20.0, 0.1, 60.0),
            rate_per_minute: number(get, "RUST_RATE_PER_MINUTE", 120.0, 1.0, 1_000_000.0) as usize,
            max_body_bytes: number(get, "RUST_MAX_BODY_BYTES", 2_000_000.0, 1000.0, 5_000_000.0) as usize,
            max_connections: number(get, "RUST_MAX_CONNECTIONS", 64.0, 1.0, 1024.0) as usize,
            workers: number(get, "RUST_WORKERS", default_workers, 1.0, 32.0) as usize,
            python_url: get("PY_SERVICE_URL").filter(|u| !u.trim().is_empty()),
            python_token: get("PY_SERVICE_TOKEN").filter(|t| !t.is_empty()),
        })
    }

    pub fn from_env() -> Result<Settings> {
        Settings::from_lookup(&|k| std::env::var(k).ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn refuses_missing_or_weak_token() {
        assert!(Settings::from_lookup(&lookup(&[])).is_err());
        assert!(Settings::from_lookup(&lookup(&[("RUST_SERVICE_TOKEN", "short")])).is_err());
    }

    #[test]
    fn defaults_and_clamping() {
        let s = Settings::from_lookup(&lookup(&[
            ("RUST_SERVICE_TOKEN", "0123456789abcdef"),
            ("RUST_TIMEOUT_SECONDS", "9999"),
            ("RUST_MAX_BODY_BYTES", "-5"),
            ("RUST_RATE_PER_MINUTE", "abc"),
        ]))
        .unwrap();
        assert_eq!(s.timeout_seconds, 60.0);
        assert_eq!(s.max_body_bytes, 1000);
        assert_eq!(s.rate_per_minute, 120);
        assert_eq!(s.host, "127.0.0.1");
        assert!(s.workers >= 1 && s.python_url.is_none());
    }
}
