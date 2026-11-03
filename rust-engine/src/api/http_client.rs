//! A minimal HTTP/1.1 client for talking to the other engines (standard library only).
//!
//! Rust's standard library has no TLS, so this client speaks plain `http://` and therefore REFUSES any address that is not
//! on this machine or a private network (loopback, 10.x, 172.16-31.x, 192.168.x, IPv6 unique-local). For a service on the
//! public internet, put a TLS-terminating proxy in front and reach it over the private network.
//! No redirects are followed, responses are size-capped, and every step has a time limit.

use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub enum ClientError {
    /// The address is not allowed (not http, not private, or a malformed URL/token).
    Refused(String),
    Unavailable,
    Timeout,
    BadResponse(String),
    TooLarge,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

pub fn parse_url(url: &str) -> Result<Target, ClientError> {
    let rest = url
        .trim()
        .strip_prefix("http://")
        .ok_or_else(|| ClientError::Refused("only http:// addresses on a private network are supported".into()))?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    if authority.is_empty() || authority.contains('@') || path.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return Err(ClientError::Refused("malformed address".into()));
    }
    let (host, port) = if let Some(stripped) = authority.strip_prefix('[') {
        let end = stripped.find(']').ok_or_else(|| ClientError::Refused("malformed address".into()))?;
        let port = match &stripped[end + 1..] {
            "" => 80,
            p => p.strip_prefix(':').and_then(|p| p.parse().ok()).ok_or_else(|| ClientError::Refused("malformed port".into()))?,
        };
        (stripped[..end].to_string(), port)
    } else if let Some((h, p)) = authority.rsplit_once(':') {
        (h.to_string(), p.parse().map_err(|_| ClientError::Refused("malformed port".into()))?)
    } else {
        (authority.to_string(), 80)
    };
    if host.is_empty() || port == 0 {
        return Err(ClientError::Refused("malformed address".into()));
    }
    Ok(Target { host, port, path })
}

pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

/// Resolves the host and refuses unless EVERY resulting address is private or loopback.
fn resolve_private(t: &Target) -> Result<Vec<SocketAddr>, ClientError> {
    let addrs: Vec<SocketAddr> = (t.host.as_str(), t.port).to_socket_addrs().map_err(|_| ClientError::Unavailable)?.collect();
    if addrs.is_empty() {
        return Err(ClientError::Unavailable);
    }
    if addrs.iter().any(|a| !is_private(a.ip())) {
        return Err(ClientError::Refused("this address is not on a private network (plain http is only allowed there)".into()));
    }
    Ok(addrs)
}

fn header_safe(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b > b' ' && b < 0x7f)
}

pub fn post_json(t: &Target, token: Option<&str>, body: &str, timeout: Duration, max_response: usize) -> Result<Response, ClientError> {
    if let Some(tok) = token {
        if !header_safe(tok) {
            return Err(ClientError::Refused("the service token contains characters that are not allowed".into()));
        }
    }
    let start = Instant::now();
    let left = |start: Instant| timeout.checked_sub(start.elapsed()).filter(|d| !d.is_zero()).ok_or(ClientError::Timeout);
    let addrs = resolve_private(t)?;
    let mut stream = None;
    for a in &addrs {
        if let Ok(s) = TcpStream::connect_timeout(a, left(start)?.min(Duration::from_secs(5))) {
            stream = Some(s);
            break;
        }
    }
    let mut stream = stream.ok_or(ClientError::Unavailable)?;
    let _ = stream.set_nodelay(true);

    let mut req = format!(
        "POST {} HTTP/1.1\r\nHost: {}:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        t.path, t.host, t.port, body.len()
    );
    if let Some(tok) = token {
        req.push_str(&format!("Authorization: Bearer {tok}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body); // one write: headers and body travel together
    stream.set_write_timeout(Some(left(start)?)).map_err(|_| ClientError::Unavailable)?;
    stream.write_all(req.as_bytes()).map_err(|_| ClientError::Unavailable)?;

    let mut raw: Vec<u8> = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        stream.set_read_timeout(Some(left(start)?)).map_err(|_| ClientError::Unavailable)?;
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() > max_response + 16 * 1024 {
                    return Err(ClientError::TooLarge);
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => return Err(ClientError::Timeout),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(ClientError::Unavailable),
        }
    }
    parse_response(&raw, max_response)
}

pub fn parse_response(raw: &[u8], max_body: usize) -> Result<Response, ClientError> {
    let bad = |m: &str| ClientError::BadResponse(m.to_string());
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| bad("no header end"))?;
    let head = std::str::from_utf8(&raw[..split]).map_err(|_| bad("headers are not text"))?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().ok_or_else(|| bad("empty response"))?;
    let mut parts = status_line.split_whitespace();
    let version = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/1.") {
        return Err(bad("not an HTTP/1.x response"));
    }
    let status: u16 = parts.next().and_then(|s| s.parse().ok()).ok_or_else(|| bad("bad status"))?;
    let mut content_length: Option<usize> = None;
    for line in lines {
        let Some((k, v)) = line.split_once(':') else { return Err(bad("bad header")) };
        match k.trim().to_ascii_lowercase().as_str() {
            "transfer-encoding" => return Err(bad("chunked responses are not supported")),
            "content-length" => {
                let n = v.trim().parse().map_err(|_| bad("bad content-length"))?;
                if content_length.replace(n).is_some() {
                    return Err(bad("duplicate content-length"));
                }
            }
            _ => {}
        }
    }
    let body = &raw[split + 4..];
    let body = match content_length {
        Some(n) if body.len() < n => return Err(bad("response body is incomplete")),
        Some(n) => &body[..n],
        None => body,
    };
    if body.len() > max_body {
        return Err(ClientError::TooLarge);
    }
    Ok(Response { status, body: String::from_utf8(body.to_vec()).map_err(|_| bad("body is not text"))? })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn url_parsing() {
        assert_eq!(parse_url("http://127.0.0.1:8080/run").unwrap(), Target { host: "127.0.0.1".into(), port: 8080, path: "/run".into() });
        assert_eq!(parse_url("http://localhost").unwrap().port, 80);
        assert_eq!(parse_url("http://[::1]:9/x").unwrap().host, "::1");
        for bad in ["https://127.0.0.1/", "ftp://x", "127.0.0.1:80", "http://", "http://u:p@127.0.0.1/", "http://127.0.0.1:0/", "http://127.0.0.1:abc/", "http://127.0.0.1/a b"] {
            assert!(matches!(parse_url(bad), Err(ClientError::Refused(_))), "{bad}");
        }
    }

    #[test]
    fn only_private_addresses_are_allowed() {
        for ok in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "::1", "fd00::1"] {
            assert!(is_private(ok.parse().unwrap()), "{ok}");
        }
        for public in ["8.8.8.8", "172.32.0.1", "1.1.1.1", "169.254.169.254", "2001:db8::1", "0.0.0.0"] {
            assert!(!is_private(public.parse().unwrap()), "{public}");
        }
        let t = parse_url("http://8.8.8.8/run").unwrap();
        assert!(matches!(post_json(&t, None, "{}", Duration::from_secs(1), 1000), Err(ClientError::Refused(_))));
    }

    #[test]
    fn rejects_tokens_that_could_inject_headers() {
        let t = parse_url("http://127.0.0.1:9/run").unwrap();
        for tok in ["a\r\nX: y", "a b", "", "tab\t"] {
            assert!(matches!(post_json(&t, Some(tok), "{}", Duration::from_secs(1), 1000), Err(ClientError::Refused(_))), "{tok:?}");
        }
    }

    fn one_shot(reply: &'static [u8], stall: bool) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut got = vec![0u8; 4096];
            let n = s.read(&mut got).unwrap();
            got.truncate(n);
            if stall {
                std::thread::sleep(Duration::from_millis(600));
            } else {
                s.write_all(reply).unwrap();
            }
            got
        });
        (port, h)
    }

    #[test]
    fn real_round_trip_sends_token_and_body() {
        let (port, h) = one_shot(b"HTTP/1.0 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}", false);
        let t = parse_url(&format!("http://127.0.0.1:{port}/run")).unwrap();
        let r = post_json(&t, Some("tok-123456789012345"), "{\"a\":1}", Duration::from_secs(3), 1000).unwrap();
        assert_eq!((r.status, r.body.as_str()), (200, "{\"ok\":true}"));
        let sent = String::from_utf8(h.join().unwrap()).unwrap();
        assert!(sent.starts_with("POST /run HTTP/1.1\r\n") && sent.contains("Authorization: Bearer tok-123456789012345\r\n"));
        assert!(sent.ends_with("{\"a\":1}") && sent.contains("Content-Length: 7\r\n"));
    }

    #[test]
    fn slow_server_times_out() {
        let (port, h) = one_shot(b"", true);
        let t = parse_url(&format!("http://127.0.0.1:{port}/")).unwrap();
        let t0 = Instant::now();
        assert_eq!(post_json(&t, None, "{}", Duration::from_millis(200), 1000), Err(ClientError::Timeout));
        assert!(t0.elapsed() < Duration::from_secs(2));
        let _ = h.join();
    }

    #[test]
    fn dead_port_is_unavailable() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let t = parse_url(&format!("http://127.0.0.1:{port}/")).unwrap();
        assert_eq!(post_json(&t, None, "{}", Duration::from_secs(1), 1000), Err(ClientError::Unavailable));
    }

    #[test]
    fn response_parsing_is_strict() {
        assert_eq!(parse_response(b"HTTP/1.1 429 Too Many\r\nA: b\r\n\r\nhello", 100).unwrap().status, 429);
        assert_eq!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhello", 100).unwrap().body, "he");
        for bad in [
            &b"garbage"[..], b"HTTP/2 200\r\n\r\n", b"HTTP/1.1 abc\r\n\r\n", b"HTTP/1.1 200\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
            b"HTTP/1.1 200\r\nContent-Length: 9\r\n\r\nhi", b"HTTP/1.1 200\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx",
            b"HTTP/1.1 200\r\nnocolon\r\n\r\n", b"HTTP/1.1 200\r\n\r\n\xff\xfe",
        ] {
            assert!(parse_response(bad, 100).is_err(), "{:?}", String::from_utf8_lossy(bad));
        }
        assert_eq!(parse_response(b"HTTP/1.1 200 OK\r\n\r\n0123456789", 5), Err(ClientError::TooLarge));
    }
}
