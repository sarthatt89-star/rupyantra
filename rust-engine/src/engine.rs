//! The ONLY door into the Rust engine's own calculations: function name + arguments in, one result envelope out.
//!
//! Every envelope carries real execution metadata produced here: engine, function, executed, success, execution_id,
//! duration_ms, version. `executed` is true only when the function actually started. Nothing is faked, and only the names
//! in `REGISTRY` can ever run: there is no way to send code.

use crate::computing::Deadline;
use crate::data::{batch, csv_profile, rolling};
use crate::errors::{Code, EngineError, Result};
use crate::json::{self, obj, Json};
use crate::version::{ENGINE, VERSION};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub const MAX_REQUEST_BYTES: usize = 5_000_000;

/// What a running calculation may use: a deadline it must keep checking and a worker limit.
pub struct Ctx {
    pub deadline: Deadline,
    pub workers: usize,
}

type Run = fn(&Json, &Ctx) -> Result<Json>;

pub struct Func {
    pub name: &'static str,
    pub required: &'static [&'static str],
    pub optional: &'static [&'static str],
    pub run: Run,
}

pub const REGISTRY: &[Func] = &[
    Func { name: "csv_profile", required: &["csv"], optional: &["has_header", "delimiter"], run: |a, c| csv_profile::csv_profile(a, &c.deadline) },
    Func { name: "batch_returns", required: &["datasets"], optional: &["kind"], run: |a, c| batch::batch_returns(a, c.workers, &c.deadline) },
    Func { name: "rolling_stats", required: &["values", "window"], optional: &[], run: |a, c| rolling::rolling_stats(a, &c.deadline) },
];

pub fn lookup(name: &str) -> Option<&'static Func> {
    REGISTRY.iter().find(|f| f.name == name)
}

pub fn functions() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = REGISTRY.iter().map(|f| f.name).collect();
    v.sort_unstable();
    v
}

/// Identity for /health (not a calculation, so no execution id).
pub fn info() -> Json {
    obj(vec![
        ("engine", Json::str(ENGINE)),
        ("version", Json::str(VERSION)),
        ("functions", Json::Arr(functions().into_iter().map(Json::str).collect())),
    ])
}

/// 32 hex characters, unique per execution (a process counter mixed with time through randomly keyed hashers).
pub fn new_execution_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    let half = |salt: u64| {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(n);
        h.write_u64(nanos);
        h.write_u64(salt);
        h.finish()
    };
    format!("{:016x}{:016x}", half(1), half(2))
}

pub struct Outcome {
    /// The JSON text to send back.
    pub body: String,
    pub execution_id: String,
    /// The approved function name when the request named one (safe to log); None otherwise.
    pub function: Option<&'static str>,
    pub executed: bool,
    pub success: bool,
    pub duration_ms: f64,
    /// Set when the call failed; the HTTP layer uses it (for example TIMEOUT becomes status 504).
    pub error_code: Option<Code>,
}

fn envelope(function: Option<&str>, executed: bool, success: bool, id: &str, duration_ms: f64, tail: (&str, Json)) -> Json {
    let function = match function {
        Some(f) if f.chars().count() <= 80 => Json::str(f),
        _ => Json::Null,
    };
    obj(vec![
        ("engine", Json::str(ENGINE)),
        ("function", function),
        ("executed", Json::Bool(executed)),
        ("success", Json::Bool(success)),
        ("execution_id", Json::str(id)),
        ("duration_ms", Json::Num(duration_ms)),
        ("version", Json::str(VERSION)),
        (tail.0, tail.1),
    ])
}

fn error_json(e: &EngineError) -> Json {
    obj(vec![("code", Json::str(e.code.as_str())), ("message", Json::str(e.message.clone()))])
}

/// A failure that happened before or around a calculation (used by the HTTP layer too). `executed` must be true only if the
/// function really started.
pub fn failure(function: Option<&str>, e: &EngineError, executed: bool) -> Outcome {
    let id = new_execution_id();
    let body = json::to_string(&envelope(function, executed, false, &id, 0.0, ("error", error_json(e))))
        .unwrap_or_else(|_| "{\"engine\":\"rust\",\"success\":false}".to_string());
    Outcome { body, execution_id: id, function: None, executed, success: false, duration_ms: 0.0, error_code: Some(e.code) }
}

/// Run one approved function. Never panics, never returns an error: failures are reported inside the envelope.
pub fn execute(function: &str, args: Option<&Json>, ctx: &Ctx) -> Outcome {
    let t0 = Instant::now();
    let id = new_execution_id();
    let done = |executed: bool, result: std::result::Result<Json, EngineError>, approved: Option<&'static str>| {
        let duration_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let (success, tail) = match &result {
            Ok(v) => (true, ("result", v.clone())),
            Err(e) => (false, ("error", error_json(e))),
        };
        let mut text = json::to_string(&envelope(Some(function), executed, success, &id, duration_ms, tail));
        let (mut success, mut final_executed) = (success, executed);
        let mut error_code = result.as_ref().err().map(|e| e.code);
        if text.is_err() {
            // a NaN or infinity must never leave the engine
            let e = EngineError::new(Code::NonFiniteResult, "the calculation did not produce a finite result");
            text = json::to_string(&envelope(Some(function), true, false, &id, duration_ms, ("error", error_json(&e))));
            success = false;
            final_executed = true;
            error_code = Some(Code::NonFiniteResult);
        }
        Outcome {
            body: text.unwrap_or_else(|_| "{\"engine\":\"rust\",\"success\":false}".into()),
            execution_id: id.clone(),
            function: approved,
            executed: final_executed,
            success,
            duration_ms,
            error_code,
        }
    };

    let Some(func) = lookup(function) else {
        return done(false, Err(EngineError::new(Code::NotApproved, "function is not approved")), None);
    };
    let empty = Json::Obj(vec![]);
    let args = args.unwrap_or(&empty);
    let Some(items) = args.as_object() else {
        return done(false, Err(EngineError::new(Code::BadRequest, "args must be an object")), Some(func.name));
    };
    for (k, _) in items {
        if !func.required.contains(&k.as_str()) && !func.optional.contains(&k.as_str()) {
            let shown: String = k.chars().take(40).collect();
            return done(false, Err(EngineError::new(Code::BadRequest, format!("unknown argument: {shown}"))), Some(func.name));
        }
    }
    for k in func.required {
        if args.get(k).is_none() {
            return done(false, Err(EngineError::new(Code::BadRequest, format!("missing argument: {k}"))), Some(func.name));
        }
    }
    let run = catch_unwind(AssertUnwindSafe(|| (func.run)(args, ctx)));
    let result = match run {
        Ok(r) => r,
        Err(_) => Err(EngineError::new(Code::Internal, "calculation failed")), // details are deliberately not leaked
    };
    done(true, result, Some(func.name))
}

/// JSON text in: {"function": "...", "args": {...}}. JSON text out.
pub fn execute_text(text: &str, ctx: &Ctx) -> Outcome {
    if text.len() > MAX_REQUEST_BYTES {
        return failure(None, &EngineError::new(Code::TooLarge, "request is too large"), false);
    }
    match json::parse(text) {
        Ok(req) => execute_parsed(&req, ctx),
        Err(_) => failure(None, &EngineError::new(Code::BadRequest, "request is not valid JSON"), false),
    }
}

/// Same as `execute_text` for a request that has already been parsed (the server parses once to decide who owns it).
pub fn execute_parsed(req: &Json, ctx: &Ctx) -> Outcome {
    if req.as_object().is_none() {
        return failure(None, &EngineError::new(Code::BadRequest, "request must be a JSON object"), false);
    }
    let Some(function) = req.get("function") else {
        return failure(None, &EngineError::new(Code::BadRequest, "function missing"), false);
    };
    let Some(name) = function.as_str() else {
        return failure(None, &EngineError::new(Code::NotApproved, "function is not approved"), false);
    };
    let args = match req.get("args") {
        None | Some(Json::Null) => None,
        Some(a) => Some(a),
    };
    execute(name, args, ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn ctx() -> Ctx {
        Ctx { deadline: Deadline::none(), workers: 2 }
    }
    fn parse(o: &Outcome) -> Json {
        json::parse(&o.body).unwrap()
    }

    #[test]
    fn success_envelope_has_real_metadata() {
        let o = execute_text("{\"function\":\"rolling_stats\",\"args\":{\"values\":[1,2,3,4],\"window\":2}}", &ctx());
        let e = parse(&o);
        assert_eq!(e.get("engine").unwrap().as_str(), Some("rust"));
        assert_eq!(e.get("function").unwrap().as_str(), Some("rolling_stats"));
        assert_eq!((e.get("executed").unwrap().as_bool(), e.get("success").unwrap().as_bool()), (Some(true), Some(true)));
        assert_eq!(e.get("version").unwrap().as_str(), Some(VERSION));
        let id = e.get("execution_id").unwrap().as_str().unwrap();
        assert_eq!(id.len(), 32);
        assert!(id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert!(e.get("duration_ms").unwrap().as_f64().unwrap() >= 0.0);
        assert!(e.get("result").is_some() && e.get("error").is_none());
        assert!(o.executed && o.success && o.function == Some("rolling_stats"));
    }

    #[test]
    fn execution_ids_are_unique() {
        let ids: HashSet<String> = (0..20_000).map(|_| new_execution_id()).collect();
        assert_eq!(ids.len(), 20_000);
    }

    #[test]
    fn unapproved_names_never_run() {
        for name in ["run_shell", "eval", "exec", "os.system", "", "ROLLING_STATS", "rolling_stats ", "__import__('os')", "describe_series"] {
            let o = execute(name, None, &ctx());
            let e = parse(&o);
            assert!(!o.executed && !o.success, "{name}");
            assert_eq!(e.get("error").unwrap().get("code").unwrap().as_str(), Some("NOT_APPROVED"), "{name}");
            assert_eq!(o.function, None);
        }
        let o = execute_text("{\"function\":5}", &ctx());
        assert_eq!(parse(&o).get("error").unwrap().get("code").unwrap().as_str(), Some("NOT_APPROVED"));
        let long = "x".repeat(500);
        assert_eq!(parse(&execute(&long, None, &ctx())).get("function"), Some(&Json::Null));
    }

    #[test]
    fn argument_problems_are_bad_requests_and_not_executed() {
        let code = |text: &str| {
            let o = execute_text(text, &ctx());
            (parse(&o).get("error").unwrap().get("code").unwrap().as_str().unwrap().to_string(), o.executed)
        };
        assert_eq!(code("{\"function\":\"rolling_stats\",\"args\":{}}"), ("BAD_REQUEST".into(), false));
        assert_eq!(code("{\"function\":\"rolling_stats\",\"args\":{\"values\":[1,2,3],\"window\":2,\"eval\":\"1\"}}"), ("BAD_REQUEST".into(), false));
        assert_eq!(code("{\"function\":\"rolling_stats\",\"args\":[1,2]}"), ("BAD_REQUEST".into(), false));
        assert_eq!(code("{\"function\":\"rolling_stats\",\"args\":\"x\"}"), ("BAD_REQUEST".into(), false));
        assert_eq!(code("not json"), ("BAD_REQUEST".into(), false));
        assert_eq!(code("[1,2]"), ("BAD_REQUEST".into(), false));
        assert_eq!(code("{\"args\":{}}"), ("BAD_REQUEST".into(), false));
        assert_eq!(code("{\"function\":\"rolling_stats\",\"args\":{\"values\":[1,NaN],\"window\":2}}"), ("BAD_REQUEST".into(), false));
    }

    #[test]
    fn invalid_values_are_executed_but_unsuccessful() {
        let o = execute_text("{\"function\":\"rolling_stats\",\"args\":{\"values\":[1,null,3],\"window\":2}}", &ctx());
        let e = parse(&o);
        assert!(o.executed && !o.success);
        assert_eq!(e.get("error").unwrap().get("code").unwrap().as_str(), Some("INVALID_INPUT"));
        assert!(e.get("error").unwrap().get("message").unwrap().as_str().unwrap().contains("values[1]"));
        assert!(e.get("result").is_none());
    }

    #[test]
    fn oversized_request_is_refused() {
        let o = execute_text(&"x".repeat(MAX_REQUEST_BYTES + 1), &ctx());
        assert_eq!(parse(&o).get("error").unwrap().get("code").unwrap().as_str(), Some("TOO_LARGE"));
        assert!(!o.executed);
    }

    #[test]
    fn same_input_same_result() {
        let req = "{\"function\":\"batch_returns\",\"args\":{\"datasets\":{\"a\":[1,2,3,4],\"b\":[5,4,6,7]}}}";
        let (a, b) = (parse(&execute_text(req, &ctx())), parse(&execute_text(req, &ctx())));
        assert_eq!(a.get("result"), b.get("result"));
        assert_ne!(a.get("execution_id"), b.get("execution_id"));
    }

    #[test]
    fn a_panic_inside_a_function_is_contained_and_not_leaked() {
        fn boom(_: &Json, _: &Ctx) -> Result<Json> {
            panic!("secret path /etc/passwd")
        }
        let f = Func { name: "boom", required: &[], optional: &[], run: boom };
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let r = catch_unwind(AssertUnwindSafe(|| (f.run)(&Json::Null, &ctx())));
        std::panic::set_hook(prev);
        assert!(r.is_err(), "the panic is real; execute() turns exactly this into INTERNAL_ERROR");
    }

    #[test]
    fn engine_does_not_repeat_other_engines() {
        let names = functions().join(" ");
        for banned in ["emi", "sip", "tax", "monte", "optimi", "frontier", "forecast", "var", "drawdown", "portfolio", "anomal"] {
            assert!(!names.contains(banned), "{banned} belongs to another engine");
        }
    }
}
