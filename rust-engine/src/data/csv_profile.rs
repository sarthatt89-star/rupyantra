//! `csv_profile`: reads CSV text and REPORTS what is in it: columns, empty cells, non-numeric cells, ragged rows and exact
//! duplicate rows. The data itself is never cleaned, filled or modified; fixing it is the owner's decision.

use crate::computing::Deadline;
use crate::errors::{EngineError, Result};
use crate::json::{obj, Json};
use crate::validate::{opt_bool, opt_str, required_str, stable_sum};
use std::collections::HashMap;

pub const MAX_ROWS: usize = 200_000;
pub const MAX_COLUMNS: usize = 200;
const SAMPLE: usize = 10;

/// Reads CSV with quoted fields ("" is a quote, newlines allowed inside quotes). Blank lines are counted, not kept.
pub fn parse_csv(text: &str, delimiter: char, deadline: &Deadline) -> Result<(Vec<Vec<String>>, usize)> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut field_was_quoted = false;
    let mut blank_lines = 0usize;
    let mut chars = text.chars().peekable();

    let finish_row = |row: &mut Vec<String>, field: &mut String, quoted: &mut bool, rows: &mut Vec<Vec<String>>, blank: &mut usize| -> Result<()> {
        if row.is_empty() && field.is_empty() && !*quoted {
            *blank += 1;
            return Ok(());
        }
        row.push(std::mem::take(field));
        *quoted = false;
        if row.len() > MAX_COLUMNS {
            return Err(EngineError::invalid(format!("more than {MAX_COLUMNS} columns")));
        }
        rows.push(std::mem::take(row));
        if rows.len() > MAX_ROWS + 1 {
            return Err(EngineError::invalid(format!("more than {MAX_ROWS} rows")));
        }
        if rows.len() % 1000 == 0 {
            deadline.check()?;
        }
        Ok(())
    };

    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' && field.is_empty() && !field_was_quoted {
            in_quotes = true;
            field_was_quoted = true;
        } else if c == delimiter {
            row.push(std::mem::take(&mut field));
            field_was_quoted = false;
            if row.len() > MAX_COLUMNS {
                return Err(EngineError::invalid(format!("more than {MAX_COLUMNS} columns")));
            }
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            finish_row(&mut row, &mut field, &mut field_was_quoted, &mut rows, &mut blank_lines)?;
        } else {
            field.push(c);
        }
    }
    if in_quotes {
        return Err(EngineError::invalid("the CSV ends inside a quoted field (a closing quote is missing)"));
    }
    if !(row.is_empty() && field.is_empty() && !field_was_quoted) {
        finish_row(&mut row, &mut field, &mut field_was_quoted, &mut rows, &mut blank_lines)?;
    }
    Ok((rows, blank_lines))
}

fn numeric(cell: &str) -> Option<f64> {
    let t = cell.trim();
    if t.is_empty() {
        return None;
    }
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn clip(s: &str) -> String {
    s.chars().take(40).collect()
}

pub fn csv_profile(args: &Json, deadline: &Deadline) -> Result<Json> {
    let text = required_str(args, "csv")?;
    let has_header = opt_bool(args, "has_header", true)?;
    let delim = opt_str(args, "delimiter", ",", &[",", ";", "\t", "|"])?;
    let delimiter = delim.chars().next().unwrap_or(',');

    let (rows, blank_lines) = parse_csv(text, delimiter, deadline)?;
    if rows.is_empty() {
        return Err(EngineError::invalid("the CSV has no rows"));
    }
    let (header, data): (Vec<String>, &[Vec<String>]) = if has_header {
        (rows[0].clone(), &rows[1..])
    } else {
        ((1..=rows[0].len()).map(|i| format!("column_{i}")).collect(), &rows[..])
    };
    let ncols = header.len();

    let mut duplicate_header: Vec<Json> = Vec::new();
    {
        let mut seen: HashMap<&str, usize> = HashMap::new();
        for h in &header {
            *seen.entry(h.as_str()).or_insert(0) += 1;
        }
        for h in &header {
            if seen.get(h.as_str()).copied().unwrap_or(0) > 1 && !duplicate_header.contains(&Json::str(h.clone())) {
                duplicate_header.push(Json::str(h.clone()));
            }
        }
    }

    // ragged rows
    let mut ragged_count = 0usize;
    let mut ragged_sample: Vec<Json> = Vec::new();
    for (i, r) in data.iter().enumerate() {
        if r.len() != ncols {
            ragged_count += 1;
            if ragged_sample.len() < SAMPLE {
                ragged_sample.push(obj(vec![("row", Json::usize(i + 1)), ("fields", Json::usize(r.len()))]));
            }
        }
    }

    // exact duplicate rows
    let mut first_seen: HashMap<&[String], usize> = HashMap::new();
    let mut duplicate_count = 0usize;
    let mut duplicate_sample: Vec<Json> = Vec::new();
    for (i, r) in data.iter().enumerate() {
        if i % 5000 == 0 {
            deadline.check()?;
        }
        match first_seen.get(r.as_slice()) {
            Some(&first) => {
                duplicate_count += 1;
                if duplicate_sample.len() < SAMPLE {
                    duplicate_sample.push(obj(vec![("first_row", Json::usize(first + 1)), ("duplicate_row", Json::usize(i + 1))]));
                }
            }
            None => {
                first_seen.insert(r.as_slice(), i);
            }
        }
    }

    // per-column facts
    let mut columns: Vec<Json> = Vec::with_capacity(ncols);
    for (c, column_name) in header.iter().enumerate() {
        deadline.check()?;
        let (mut empty, mut non_numeric) = (0usize, 0usize);
        let mut nums: Vec<f64> = Vec::new();
        let mut examples: Vec<Json> = Vec::new();
        for r in data {
            match r.get(c) {
                None => {}
                Some(cell) if cell.trim().is_empty() => empty += 1,
                Some(cell) => match numeric(cell) {
                    Some(v) => nums.push(v),
                    None => {
                        non_numeric += 1;
                        if examples.len() < 3 && !examples.contains(&Json::str(clip(cell))) {
                            examples.push(Json::str(clip(cell)));
                        }
                    }
                },
            }
        }
        let non_empty = nums.len() + non_numeric;
        let kind = if non_empty == 0 {
            "empty"
        } else if non_numeric == 0 {
            "numeric"
        } else if nums.is_empty() {
            "text"
        } else {
            "mixed"
        };
        let (min, max, mean) = if nums.is_empty() {
            (None, None, None)
        } else {
            (
                nums.iter().copied().fold(f64::INFINITY, f64::min).into(),
                nums.iter().copied().fold(f64::NEG_INFINITY, f64::max).into(),
                Some(stable_sum(nums.iter().copied()) / nums.len() as f64),
            )
        };
        columns.push(obj(vec![
            ("name", Json::str(column_name.clone())),
            ("type", Json::str(kind)),
            ("non_empty", Json::usize(non_empty)),
            ("empty", Json::usize(empty)),
            ("numeric", Json::usize(nums.len())),
            ("non_numeric", Json::usize(non_numeric)),
            ("non_numeric_examples", Json::Arr(examples)),
            ("min", Json::opt(min)),
            ("max", Json::opt(max)),
            ("mean", Json::opt(mean)),
        ]));
    }

    Ok(obj(vec![
        ("rows", Json::usize(data.len())),
        ("columns", Json::usize(ncols)),
        ("has_header", Json::Bool(has_header)),
        ("blank_lines_skipped", Json::usize(blank_lines)),
        ("ragged_rows", Json::usize(ragged_count)),
        ("ragged_row_sample", Json::Arr(ragged_sample)),
        ("duplicate_rows", Json::usize(duplicate_count)),
        ("duplicate_row_sample", Json::Arr(duplicate_sample)),
        ("duplicate_header_names", Json::Arr(duplicate_header)),
        ("column_profiles", Json::Arr(columns)),
        (
            "note",
            Json::str(
                "A report only: no value was changed, filled in or removed. Numbers with thousands separators or currency \
                 signs (for example 1,234 or Rs 500) are counted as non-numeric. Row numbers start at 1 after the header.",
            ),
        ),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    fn run(csv: &str) -> Result<Json> {
        csv_profile(&obj(vec![("csv", Json::str(csv))]), &Deadline::none())
    }
    fn col(p: &Json, i: usize) -> &Json {
        &p.get("column_profiles").unwrap().as_array().unwrap()[i]
    }

    #[test]
    fn profiles_a_clean_file() {
        let p = run("date,price,name\n2024-01-01,100.5,A\n2024-01-02,101.5,B\n").unwrap();
        assert_eq!(p.get("rows").unwrap().as_f64(), Some(2.0));
        assert_eq!(p.get("columns").unwrap().as_f64(), Some(3.0));
        assert_eq!(col(&p, 1).get("type").unwrap().as_str(), Some("numeric"));
        assert_eq!(col(&p, 1).get("mean").unwrap().as_f64(), Some(101.0));
        assert_eq!(col(&p, 1).get("min").unwrap().as_f64(), Some(100.5));
        assert_eq!(col(&p, 2).get("type").unwrap().as_str(), Some("text"));
        assert_eq!(p.get("duplicate_rows").unwrap().as_f64(), Some(0.0));
    }

    #[test]
    fn finds_missing_duplicates_and_ragged_rows_without_changing_anything() {
        let csv = "a,b\n1,2\n1,2\n3,\n4\n5,x\n\n";
        let p = run(csv).unwrap();
        assert_eq!(p.get("rows").unwrap().as_f64(), Some(5.0));
        assert_eq!(p.get("duplicate_rows").unwrap().as_f64(), Some(1.0));
        assert_eq!(p.get("ragged_rows").unwrap().as_f64(), Some(1.0));
        assert_eq!(p.get("blank_lines_skipped").unwrap().as_f64(), Some(1.0));
        let b = col(&p, 1);
        assert_eq!(b.get("empty").unwrap().as_f64(), Some(1.0));
        assert_eq!(b.get("non_numeric").unwrap().as_f64(), Some(1.0));
        assert_eq!(b.get("type").unwrap().as_str(), Some("mixed"));
        let dup = &p.get("duplicate_row_sample").unwrap().as_array().unwrap()[0];
        assert_eq!((dup.get("first_row").unwrap().as_f64(), dup.get("duplicate_row").unwrap().as_f64()), (Some(1.0), Some(2.0)));
    }

    #[test]
    fn quotes_newlines_bom_crlf() {
        let p = run("\u{feff}name,note\r\n\"Smith, J\",\"he said \"\"hi\"\"\nand left\"\r\nB,2\r\n").unwrap();
        assert_eq!(p.get("rows").unwrap().as_f64(), Some(2.0));
        assert_eq!(p.get("ragged_rows").unwrap().as_f64(), Some(0.0));
        assert_eq!(col(&p, 0).get("name").unwrap().as_str(), Some("name"));
    }

    #[test]
    fn non_finite_and_formatted_numbers_are_not_numbers() {
        // `1,234` unquoted is two fields (a ragged row); only the quoted "1,234" is one text cell
        let p = run("v\nNaN\ninf\n1,234\n\"1,234\"\n7\n").unwrap();
        let c = col(&p, 0);
        assert_eq!(c.get("numeric").unwrap().as_f64(), Some(2.0));      // the leading 1 of the ragged row, and 7
        assert_eq!(c.get("non_numeric").unwrap().as_f64(), Some(3.0));  // NaN, inf, "1,234"
        assert_eq!(p.get("ragged_rows").unwrap().as_f64(), Some(1.0));
    }

    #[test]
    fn options_and_header_names() {
        let a = parse("{\"csv\":\"1;2\\n3;4\",\"has_header\":false,\"delimiter\":\";\"}").unwrap();
        let p = csv_profile(&a, &Deadline::none()).unwrap();
        assert_eq!(p.get("rows").unwrap().as_f64(), Some(2.0));
        assert_eq!(col(&p, 0).get("name").unwrap().as_str(), Some("column_1"));
        let d = run("x,x,y\n1,2,3").unwrap();
        assert_eq!(d.get("duplicate_header_names").unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn refuses_bad_input() {
        assert!(run("").is_err());
        assert!(run("a,b\n\"unterminated,1").is_err());
        assert!(csv_profile(&obj(vec![]), &Deadline::none()).is_err());
        assert!(csv_profile(&obj(vec![("csv", Json::Num(5.0))]), &Deadline::none()).is_err());
        assert!(csv_profile(&obj(vec![("csv", Json::str("a")), ("delimiter", Json::str("ab"))]), &Deadline::none()).is_err());
        let wide = (0..=MAX_COLUMNS).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        assert!(run(&wide).is_err());
    }

    #[test]
    fn large_file_is_handled() {
        let mut csv = String::from("id,value\n");
        for i in 0..MAX_ROWS {
            csv.push_str(&format!("{i},{}\n", i % 97));
        }
        let p = run(&csv).unwrap();
        assert_eq!(p.get("rows").unwrap().as_f64(), Some(MAX_ROWS as f64));
        csv.push_str("x,1\n");
        assert!(run(&csv).is_err(), "one row over the limit is refused");
    }
}
