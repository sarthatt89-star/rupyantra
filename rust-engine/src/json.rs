//! A small, strict JSON reader/writer (standard library only).
//!
//! Strict on purpose: no NaN/Infinity literals, no duplicate keys, nesting depth limited, and numbers that do not fit a
//! finite f64 are refused. Output refuses non-finite numbers, so a broken calculation can never be sent as "null" or "NaN".

use std::fmt::Write as _;

pub const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        if let Json::Num(n) = self { Some(*n) } else { None }
    }
    pub fn as_str(&self) -> Option<&str> {
        if let Json::Str(s) = self { Some(s) } else { None }
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let Json::Bool(b) = self { Some(*b) } else { None }
    }
    pub fn as_array(&self) -> Option<&[Json]> {
        if let Json::Arr(a) = self { Some(a) } else { None }
    }
    pub fn as_object(&self) -> Option<&[(String, Json)]> {
        if let Json::Obj(o) = self { Some(o) } else { None }
    }
    pub fn num(n: impl Into<f64>) -> Json {
        Json::Num(n.into())
    }
    pub fn usize(n: usize) -> Json {
        Json::Num(n as f64)
    }
    pub fn str(s: impl Into<String>) -> Json {
        Json::Str(s.into())
    }
    /// Missing / undefined numbers are reported as null, never as 0 or NaN.
    pub fn opt(n: Option<f64>) -> Json {
        match n {
            Some(v) if v.is_finite() => Json::Num(v),
            _ => Json::Null,
        }
    }
}

/// Build an object from (key, value) pairs.
pub fn obj(items: Vec<(&str, Json)>) -> Json {
    Json::Obj(items.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/* ---------------- parsing ---------------- */

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

pub fn parse(text: &str) -> Result<Json, String> {
    let mut p = Parser { b: text.as_bytes(), i: 0 };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i != p.b.len() {
        return Err(format!("unexpected text after the JSON value at byte {}", p.i));
    }
    Ok(v)
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn eat(&mut self, lit: &str) -> bool {
        if self.b[self.i..].starts_with(lit.as_bytes()) {
            self.i += lit.len();
            true
        } else {
            false
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, String> {
        if depth > MAX_DEPTH {
            return Err("JSON is nested too deeply".into());
        }
        match self.b.get(self.i) {
            None => Err("unexpected end of JSON".into()),
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') if self.eat("true") => Ok(Json::Bool(true)),
            Some(b'f') if self.eat("false") => Ok(Json::Bool(false)),
            Some(b'n') if self.eat("null") => Ok(Json::Null),
            Some(b'-') | Some(b'0'..=b'9') => self.number(),
            Some(_) => Err(format!("unexpected character at byte {}", self.i)),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, String> {
        self.i += 1;
        let mut items: Vec<(String, Json)> = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Ok(Json::Obj(items));
        }
        loop {
            self.ws();
            if self.b.get(self.i) != Some(&b'"') {
                return Err(format!("object key expected at byte {}", self.i));
            }
            let key = self.string()?;
            if items.iter().any(|(k, _)| *k == key) {
                return Err("duplicate key in object".into());
            }
            self.ws();
            if self.b.get(self.i) != Some(&b':') {
                return Err(format!("':' expected at byte {}", self.i));
            }
            self.i += 1;
            self.ws();
            let v = self.value(depth + 1)?;
            items.push((key, v));
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Json::Obj(items));
                }
                _ => return Err(format!("',' or '}}' expected at byte {}", self.i)),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, String> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            self.ws();
            items.push(self.value(depth + 1)?);
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return Err(format!("',' or ']' expected at byte {}", self.i)),
            }
        }
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.i;
        if self.b.get(self.i) == Some(&b'-') {
            self.i += 1;
        }
        match self.b.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.b.get(self.i), Some(b'0'..=b'9')) {
                    self.i += 1;
                }
            }
            _ => return Err(format!("invalid number at byte {}", start)),
        }
        if self.b.get(self.i) == Some(&b'.') {
            self.i += 1;
            let d = self.i;
            while matches!(self.b.get(self.i), Some(b'0'..=b'9')) {
                self.i += 1;
            }
            if self.i == d {
                return Err(format!("invalid number at byte {}", start));
            }
        }
        if matches!(self.b.get(self.i), Some(b'e') | Some(b'E')) {
            self.i += 1;
            if matches!(self.b.get(self.i), Some(b'+') | Some(b'-')) {
                self.i += 1;
            }
            let d = self.i;
            while matches!(self.b.get(self.i), Some(b'0'..=b'9')) {
                self.i += 1;
            }
            if self.i == d {
                return Err(format!("invalid number at byte {}", start));
            }
        }
        let s = std::str::from_utf8(&self.b[start..self.i]).map_err(|_| "invalid number".to_string())?;
        let n: f64 = s.parse().map_err(|_| format!("invalid number at byte {}", start))?;
        if !n.is_finite() {
            return Err("number is too large".into());
        }
        Ok(Json::Num(n))
    }

    fn hex4(&mut self) -> Result<u32, String> {
        if self.i + 4 > self.b.len() {
            return Err("bad \\u escape".into());
        }
        let s = std::str::from_utf8(&self.b[self.i..self.i + 4]).map_err(|_| "bad \\u escape".to_string())?;
        if !s.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("bad \\u escape".into());
        }
        self.i += 4;
        u32::from_str_radix(s, 16).map_err(|_| "bad \\u escape".to_string())
    }

    fn string(&mut self) -> Result<String, String> {
        self.i += 1; // opening quote
        let mut out = String::new();
        loop {
            // copy a run of plain bytes at once (the input is valid UTF-8 because it came from &str)
            let run_start = self.i;
            while self.i < self.b.len() && self.b[self.i] != b'"' && self.b[self.i] != b'\\' && self.b[self.i] >= 0x20 {
                self.i += 1;
            }
            out.push_str(std::str::from_utf8(&self.b[run_start..self.i]).map_err(|_| "invalid text".to_string())?);
            match self.b.get(self.i) {
                None => return Err("unterminated string".into()),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let c = *self.b.get(self.i).ok_or("unterminated string")?;
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..0xDC00).contains(&hi) {
                                if !self.eat("\\u") {
                                    return Err("unpaired surrogate".into());
                                }
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err("unpaired surrogate".into());
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else if (0xDC00..0xE000).contains(&hi) {
                                return Err("unpaired surrogate".into());
                            } else {
                                hi
                            };
                            out.push(char::from_u32(cp).ok_or("invalid character")?);
                        }
                        _ => return Err("bad escape in string".into()),
                    }
                }
                Some(_) => return Err("control character inside string".into()),
            }
        }
    }
}

/* ---------------- writing ---------------- */

pub fn to_string(v: &Json) -> Result<String, String> {
    let mut out = String::new();
    write_value(v, &mut out)?;
    Ok(out)
}

fn write_value(v: &Json, out: &mut String) -> Result<(), String> {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Num(n) => {
            if !n.is_finite() {
                return Err("a number is not finite".into());
            }
            if *n == 0.0 {
                out.push('0'); // also turns -0 into 0
            } else {
                write!(out, "{}", n).map_err(|_| "write failed".to_string())?;
            }
        }
        Json::Str(s) => write_string(s, out),
        Json::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(x, out)?;
            }
            out.push(']');
        }
        Json::Obj(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(k, out);
                out.push(':');
                write_value(x, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

pub fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let text = r#"{"a":[1,2.5,-3e2,true,null],"b":{"c":"x\ny\u00e9\ud83d\ude00"},"d":""}"#;
        let v = parse(text).unwrap();
        assert_eq!(v.get("a").unwrap().as_array().unwrap().len(), 5);
        assert_eq!(v.get("b").unwrap().get("c").unwrap().as_str().unwrap(), "x\nyé😀");
        let again = parse(&to_string(&v).unwrap()).unwrap();
        assert_eq!(v, again);
    }

    #[test]
    fn rejects_bad_json() {
        for bad in [
            "", "{", "[1,]", "{\"a\":1,}", "NaN", "Infinity", "[NaN]", "01", "1.", ".5", "-", "1e", "\"abc", "[1] x",
            "{\"a\":1,\"a\":2}", "'a'", "[\"\u{1}\"]", "\"\\ud800\"", "\"\\x\"", "1e999", "{\"a\" 1}", "[1 2]",
        ] {
            assert!(parse(bad).is_err(), "should refuse: {bad:?}");
        }
    }

    #[test]
    fn depth_is_limited() {
        let deep = "[".repeat(100_000) + &"]".repeat(100_000);
        assert!(parse(&deep).is_err());
        let ok = "[".repeat(60) + &"]".repeat(60);
        assert!(parse(&ok).is_ok());
    }

    #[test]
    fn output_refuses_non_finite_numbers() {
        assert!(to_string(&Json::Num(f64::NAN)).is_err());
        assert!(to_string(&Json::Num(f64::INFINITY)).is_err());
        assert!(to_string(&Json::Arr(vec![Json::Num(1.0), Json::Num(f64::NEG_INFINITY)])).is_err());
        assert_eq!(to_string(&Json::opt(None)).unwrap(), "null");
        assert_eq!(to_string(&Json::opt(Some(f64::NAN))).unwrap(), "null");
    }

    #[test]
    fn numbers_print_exactly() {
        for n in [0.1, 1e21, 1e-7, 123456789.123456, -0.5, 5e-324, 1.7976931348623157e308] {
            let s = to_string(&Json::Num(n)).unwrap();
            assert_eq!(parse(&s).unwrap(), Json::Num(n), "{s}");
        }
        assert_eq!(to_string(&Json::Num(-0.0)).unwrap(), "0");
        assert_eq!(to_string(&Json::Num(3.0)).unwrap(), "3");
    }

    #[test]
    fn escapes_control_characters() {
        let s = to_string(&Json::Str("a\u{1}\"\\".into())).unwrap();
        assert_eq!(s, "\"a\\u0001\\\"\\\\\"");
    }
}
