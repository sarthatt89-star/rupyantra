//! Command line:
//!   rupeyantra-rust serve     secured HTTP service (settings from environment, see README)
//!   rupeyantra-rust run       reads ONE JSON request from stdin, prints ONE JSON answer
//!   rupeyantra-rust version

use rust_engine::api::server::{serve, App};
use rust_engine::computing::Deadline;
use rust_engine::config::Settings;
use rust_engine::engine::{self, Ctx};
use rust_engine::security::AuditLog;
use rust_engine::version::{ENGINE, VERSION};
use std::io::Read;
use std::net::TcpListener;
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

fn quiet_panics() {
    // A panic message could contain data from a request, so only a fixed line is ever printed.
    std::panic::set_hook(Box::new(|_| eprintln!("internal error in a calculation")));
}

fn main() -> ExitCode {
    quiet_panics();
    match std::env::args().nth(1).as_deref() {
        Some("version") => {
            println!("{ENGINE} {VERSION}");
            ExitCode::SUCCESS
        }
        Some("run") => {
            let mut text = String::new();
            let limit = engine::MAX_REQUEST_BYTES as u64 + 1;
            if std::io::stdin().take(limit).read_to_string(&mut text).is_err() {
                text.clear(); // not valid text: reported as BAD_REQUEST below
            }
            let seconds = std::env::var("RUST_TIMEOUT_SECONDS").ok().and_then(|s| s.parse::<f64>().ok()).filter(|s| s.is_finite()).unwrap_or(20.0).clamp(0.1, 60.0);
            let ctx = Ctx { deadline: Deadline::after(Duration::from_secs_f64(seconds)), workers: rust_engine::computing::default_workers() };
            println!("{}", engine::execute_text(&text, &ctx).body);
            ExitCode::SUCCESS
        }
        Some("serve") => {
            let settings = match Settings::from_env() {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("refusing to start: {}", e.message);
                    return ExitCode::from(2);
                }
            };
            let bind = format!("{}:{}", settings.host, settings.port);
            let app = match App::new(settings, AuditLog::to_stderr()) {
                Ok(a) => Arc::new(a),
                Err(e) => {
                    eprintln!("refusing to start: {}", e.message);
                    return ExitCode::from(2);
                }
            };
            let listener = match TcpListener::bind(&bind) {
                Ok(l) => l,
                Err(_) => {
                    eprintln!("refusing to start: cannot listen on {bind}");
                    return ExitCode::from(2);
                }
            };
            let shown = listener.local_addr().map(|a| a.to_string()).unwrap_or(bind);
            eprintln!("rupeyantra rust service on {shown} (version {VERSION})");
            let stop = Arc::new(AtomicBool::new(false)); // stopped by the process being terminated
            match serve(listener, app, stop) {
                Ok(()) => ExitCode::SUCCESS,
                Err(_) => ExitCode::FAILURE,
            }
        }
        _ => {
            eprintln!("usage: rupeyantra-rust serve | run | version");
            ExitCode::from(64)
        }
    }
}
