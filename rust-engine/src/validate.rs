//! Argument checks shared by every calculation. Bad input is refused with a clear message; nothing is repaired or guessed.

use crate::errors::{EngineError, Result};
use crate::json::Json;

pub const MAX_POINTS: usize = 100_000;
pub const MAX_NAME_LEN: usize = 80;

/// A list of finite numbers. A missing entry (null, text, true/false) is reported with its position.
pub fn series(v: &Json, name: &str, min_len: usize, max_len: usize, positive: bool) -> Result<Vec<f64>> {
    let items = v.as_array().ok_or_else(|| EngineError::invalid(format!("{name} must be a list of numbers")))?;
    if items.len() < min_len {
        return Err(EngineError::invalid(format!("{name} needs at least {min_len} values (got {})", items.len())));
    }
    if items.len() > max_len {
        return Err(EngineError::invalid(format!("{name} has too many values (max {max_len})")));
    }
    let mut out = Vec::with_capacity(items.len());
    for (i, x) in items.iter().enumerate() {
        let n = x.as_f64().ok_or_else(|| EngineError::invalid(format!("{name}[{i}] is missing or not a number")))?;
        if !n.is_finite() {
            return Err(EngineError::invalid(format!("{name}[{i}] is not a finite number")));
        }
        if positive && n <= 0.0 {
            return Err(EngineError::invalid(format!("{name}[{i}] must be above 0")));
        }
        out.push(n);
    }
    Ok(out)
}

pub fn label(name: &str, what: &str) -> Result<()> {
    let n = name.chars().count();
    if !(1..=MAX_NAME_LEN).contains(&n) {
        return Err(EngineError::invalid(format!("{what} must be text of 1 to {MAX_NAME_LEN} characters")));
    }
    Ok(())
}

pub fn required_str<'a>(args: &'a Json, key: &str) -> Result<&'a str> {
    args.get(key)
        .and_then(Json::as_str)
        .ok_or_else(|| EngineError::invalid(format!("{key} must be text")))
}

pub fn opt_str(args: &Json, key: &str, default: &str, allowed: &[&str]) -> Result<String> {
    match args.get(key) {
        None => Ok(default.to_string()),
        Some(Json::Str(s)) if allowed.contains(&s.as_str()) => Ok(s.clone()),
        Some(_) => Err(EngineError::invalid(format!("{key} must be one of: {}", allowed.join(", ")))),
    }
}

pub fn opt_bool(args: &Json, key: &str, default: bool) -> Result<bool> {
    match args.get(key) {
        None => Ok(default),
        Some(Json::Bool(b)) => Ok(*b),
        Some(_) => Err(EngineError::invalid(format!("{key} must be true or false"))),
    }
}

/// A whole number in [lo, hi].
pub fn usize_in(v: &Json, key: &str, lo: usize, hi: usize) -> Result<usize> {
    let n = v.as_f64().ok_or_else(|| EngineError::invalid(format!("{key} must be a number")))?;
    if n.fract() != 0.0 {
        return Err(EngineError::invalid(format!("{key} must be a whole number")));
    }
    if n < lo as f64 || n > hi as f64 {
        return Err(EngineError::invalid(format!("{key} must be between {lo} and {hi}")));
    }
    Ok(n as usize)
}

/// Sum with error compensation (Neumaier), so long series do not lose digits.
pub fn stable_sum(values: impl IntoIterator<Item = f64>) -> f64 {
    let (mut sum, mut c) = (0.0f64, 0.0f64);
    for x in values {
        let t = sum + x;
        if sum.abs() >= x.abs() {
            c += (sum - t) + x;
        } else {
            c += (x - t) + sum;
        }
        sum = t;
    }
    sum + c
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    #[test]
    fn series_reports_positions() {
        let ok = parse("[1,2,3]").unwrap();
        assert_eq!(series(&ok, "v", 1, 10, false).unwrap(), vec![1.0, 2.0, 3.0]);
        for (text, needle) in [("[1,null,3]", "v[1]"), ("[1,\"2\"]", "v[1]"), ("[true]", "v[0]"), ("[0,1]", "v[0]")] {
            let e = series(&parse(text).unwrap(), "v", 1, 10, text == "[0,1]").unwrap_err();
            assert!(e.message.contains(needle), "{text}: {}", e.message);
        }
        assert!(series(&parse("[]").unwrap(), "v", 1, 10, false).is_err());
        assert!(series(&parse("[1,2,3]").unwrap(), "v", 1, 2, false).is_err());
        assert!(series(&parse("5").unwrap(), "v", 1, 2, false).is_err());
    }

    #[test]
    fn whole_numbers_and_options() {
        assert_eq!(usize_in(&Json::Num(5.0), "w", 2, 10).unwrap(), 5);
        assert!(usize_in(&Json::Num(5.5), "w", 2, 10).is_err());
        assert!(usize_in(&Json::Num(1.0), "w", 2, 10).is_err());
        assert!(usize_in(&Json::str("5"), "w", 2, 10).is_err());
        let a = parse("{\"kind\":\"log\",\"flag\":1}").unwrap();
        assert_eq!(opt_str(&a, "kind", "simple", &["simple", "log"]).unwrap(), "log");
        assert!(opt_str(&a, "kind", "simple", &["simple"]).is_err());
        assert!(opt_bool(&a, "flag", false).is_err());
        assert!(opt_bool(&a, "missing", true).unwrap());
    }

    #[test]
    fn stable_sum_beats_naive_sum() {
        let v: Vec<f64> = std::iter::once(1e16).chain(std::iter::repeat(1.0).take(1000)).chain(std::iter::once(-1e16)).collect();
        assert_eq!(stable_sum(v.iter().copied()), 1000.0);
    }
}
