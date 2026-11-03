//! Connector to the Python engine's secured service (python-engine/server.py, POST /run).
//!
//! The Python answer is passed on UNCHANGED, after checking that it really is a complete Python execution record. This
//! engine never relabels a result: an answer from Python stays "engine: python"; if Python cannot be reached, the caller gets
//! an honest "unavailable" and nothing is calculated in its place.

use super::http_client::{parse_url, post_json, ClientError, Target};
use crate::errors::{Code, EngineError};
use crate::json::{self, obj, Json};
use crate::reliability::CircuitBreaker;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const MAX_RESPONSE_BYTES: usize = 5_000_000;
const ATTEMPTS: usize = 2; // at most one retry, and only when the connection itself could not be made

pub struct Forwarded {
    pub status: u16,
    /// The Python service's own JSON answer, verbatim.
    pub body: String,
}

pub struct PythonConnector {
    target: Target,
    token: Option<String>,
    timeout: Duration,
    breaker: Mutex<CircuitBreaker>,
}

fn unavailable(msg: &str) -> EngineError {
    EngineError::new(Code::EngineUnavailable, msg)
}

impl PythonConnector {
    /// Checks the address form now (http, no credentials in the URL). Whether the host is private is checked on every call.
    pub fn new(url: &str, token: Option<String>, timeout: Duration) -> Result<PythonConnector, EngineError> {
        let target = parse_url(url).map_err(|e| match e {
            ClientError::Refused(m) => EngineError::new(Code::BadRequest, m),
            _ => EngineError::new(Code::BadRequest, "invalid Python service address"),
        })?;
        Ok(PythonConnector { target, token, timeout, breaker: Mutex::new(CircuitBreaker::new(3, Duration::from_secs(15))) })
    }

    pub fn call(&self, function: &str, args: Option<&Json>) -> Result<Forwarded, EngineError> {
        let args = args.cloned().unwrap_or_else(|| Json::Obj(vec![]));
        let body = json::to_string(&obj(vec![("function", Json::str(function)), ("args", args)]))
            .map_err(|_| EngineError::invalid("the arguments could not be sent"))?;

        if !self.breaker.lock().map(|mut b| b.allow(Instant::now())).unwrap_or(false) {
            return Err(unavailable("the Python engine was unreachable moments ago; not trying again yet"));
        }
        let mut last = ClientError::Unavailable;
        for _ in 0..ATTEMPTS {
            match post_json(&self.target, self.token.as_deref(), &body, self.timeout, MAX_RESPONSE_BYTES) {
                Ok(resp) => {
                    return match verify_python_envelope(&resp.body, function) {
                        Ok(()) if matches!(resp.status, 200 | 413 | 429 | 504) => {
                            self.alive();
                            Ok(Forwarded { status: resp.status, body: resp.body })
                        }
                        Ok(()) | Err(_) if matches!(resp.status, 401 | 403) => {
                            self.dead();
                            Err(unavailable("the Python service did not accept this engine's credentials"))
                        }
                        Err(e) => {
                            self.dead();
                            Err(e)
                        }
                        Ok(()) => {
                            self.dead();
                            Err(EngineError::new(Code::BadResponse, "unexpected answer from the Python service"))
                        }
                    };
                }
                Err(ClientError::Refused(m)) => {
                    self.dead();
                    return Err(unavailable(&m));
                }
                Err(ClientError::Unavailable) => last = ClientError::Unavailable, // retry once
                Err(e) => {
                    last = e;
                    break; // a timeout or a broken answer is not retried
                }
            }
        }
        self.dead();
        Err(match last {
            ClientError::Timeout => EngineError::new(Code::Timeout, "the Python engine did not answer in time"),
            ClientError::TooLarge => EngineError::new(Code::BadResponse, "the Python answer is too large"),
            ClientError::BadResponse(_) => EngineError::new(Code::BadResponse, "the Python answer could not be read"),
            _ => unavailable("the Python engine could not be reached"),
        })
    }

    fn alive(&self) {
        if let Ok(mut b) = self.breaker.lock() {
            b.record_success();
        }
    }
    fn dead(&self) {
        if let Ok(mut b) = self.breaker.lock() {
            b.record_failure(Instant::now());
        }
    }
}

/// The same evidence rules the JavaScript bridge applies: only a complete Python execution record is accepted.
pub fn verify_python_envelope(text: &str, function: &str) -> Result<(), EngineError> {
    let bad = |m: &str| EngineError::new(Code::BadResponse, m.to_string());
    let v = json::parse(text).map_err(|_| bad("the Python answer is not valid JSON"))?;
    if v.as_object().is_none() || v.get("engine").and_then(Json::as_str) != Some("python") || v.get("function").and_then(Json::as_str) != Some(function) {
        return Err(bad("the answer is not from the Python engine"));
    }
    let id_ok = v.get("execution_id").and_then(Json::as_str).is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    let time_ok = v.get("duration_ms").and_then(Json::as_f64).is_some_and(|d| d >= 0.0);
    let version_ok = v.get("version").and_then(Json::as_str).is_some_and(|s| {
        let mut p = s.split('.');
        (0..3).all(|_| p.next().is_some_and(|x| !x.is_empty() && x.bytes().take_while(|b| b.is_ascii_digit()).count() > 0))
    });
    let (executed, success) = (v.get("executed").and_then(Json::as_bool), v.get("success").and_then(Json::as_bool));
    if !(id_ok && time_ok && version_ok && executed.is_some() && success.is_some()) {
        return Err(bad("the Python answer has no complete execution record"));
    }
    if success == Some(true) && !(executed == Some(true) && v.get("result").and_then(Json::as_object).is_some()) {
        return Err(bad("the Python answer claims success without a result"));
    }
    if success == Some(false) && v.get("error").and_then(Json::as_object).is_none() {
        return Err(bad("the Python answer reports a failure without an error"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    fn good(function: &str) -> String {
        format!("{{\"engine\":\"python\",\"function\":\"{function}\",\"executed\":true,\"success\":true,\"execution_id\":\"{ID}\",\"duration_ms\":1.5,\"version\":\"0.1.0\",\"result\":{{\"mean\":3}}}}")
    }

    #[test]
    fn only_complete_python_records_pass() {
        assert!(verify_python_envelope(&good("forecast"), "forecast").is_ok());
        assert!(verify_python_envelope(&good("forecast"), "describe_series").is_err(), "wrong function");
        let broken = [
            good("forecast").replace("\"python\"", "\"julia\""),
            good("forecast").replace(ID, "abc"),
            good("forecast").replace(ID, &"G".repeat(32)),
            good("forecast").replace("1.5", "-1"),
            good("forecast").replace("0.1.0", "v?"),
            good("forecast").replace("\"executed\":true,", ""),
            good("forecast").replace("\"executed\":true", "\"executed\":false"),
            good("forecast").replace("\"result\":{\"mean\":3}", "\"result\":5"),
            good("forecast").replace("\"success\":true", "\"success\":false"),
            "[1,2,3]".to_string(),
            "<html>".to_string(),
            "{\"ok\":true}".to_string(),
        ];
        for b in broken {
            assert!(verify_python_envelope(&b, "forecast").is_err(), "{b}");
        }
        let failure = good("forecast").replace("\"success\":true", "\"success\":false").replace("\"result\":{\"mean\":3}", "\"error\":{\"code\":\"INVALID_INPUT\",\"message\":\"x\"}");
        assert!(verify_python_envelope(&failure, "forecast").is_ok(), "a verified failure answer is still an honest answer");
    }

    fn fake_service(replies: Vec<(u16, String)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/run", l.local_addr().unwrap().port());
        let h = std::thread::spawn(move || {
            let mut seen = vec![];
            for (status, body) in replies {
                let (mut s, _) = l.accept().unwrap();
                let mut buf = vec![0u8; 65536];
                let n = s.read(&mut buf).unwrap();
                seen.push(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = write!(s, "HTTP/1.0 {status} X\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            }
            seen
        });
        (url, h)
    }

    #[test]
    fn verified_answer_is_forwarded_verbatim() {
        let answer = good("forecast");
        let (url, h) = fake_service(vec![(200, answer.clone())]);
        let c = PythonConnector::new(&url, Some("tok-123456789012345".into()), Duration::from_secs(3)).unwrap();
        let f = c.call("forecast", Some(&json::parse("{\"values\":[1,2,3]}").unwrap())).unwrap();
        assert_eq!((f.status, f.body), (200, answer));
        let sent = h.join().unwrap().remove(0);
        assert!(sent.contains("Authorization: Bearer tok-123456789012345") && sent.ends_with("{\"function\":\"forecast\",\"args\":{\"values\":[1,2,3]}}"));
    }

    #[test]
    fn a_forged_answer_is_rejected() {
        let (url, _h) = fake_service(vec![(200, "{\"engine\":\"python\",\"success\":true,\"result\":{}}".into())]);
        let c = PythonConnector::new(&url, None, Duration::from_secs(3)).unwrap();
        assert_eq!(c.call("forecast", None).err().unwrap().code, Code::BadResponse);
    }

    #[test]
    fn rejected_credentials_are_unavailable() {
        let (url, _h) = fake_service(vec![(401, "{\"ok\":false,\"error\":\"unauthorized\"}".into())]);
        let c = PythonConnector::new(&url, Some("wrong-token-0123456789".into()), Duration::from_secs(3)).unwrap();
        assert_eq!(c.call("forecast", None).err().unwrap().code, Code::EngineUnavailable);
    }

    #[test]
    fn dead_service_opens_the_breaker_and_stops_calling() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let c = PythonConnector::new(&format!("http://127.0.0.1:{port}/run"), None, Duration::from_secs(1)).unwrap();
        for _ in 0..3 {
            assert_eq!(c.call("forecast", None).err().unwrap().code, Code::EngineUnavailable);
        }
        let e = c.call("forecast", None).err().unwrap();
        assert!(e.message.contains("not trying again"), "{}", e.message);
    }

    #[test]
    fn public_address_is_refused() {
        let c = PythonConnector::new("http://8.8.8.8/run", None, Duration::from_secs(1)).unwrap();
        let e = c.call("forecast", None).err().unwrap();
        assert_eq!(e.code, Code::EngineUnavailable);
        assert!(PythonConnector::new("https://example.com/run", None, Duration::from_secs(1)).is_err());
    }
}
