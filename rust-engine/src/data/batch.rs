//! `batch_returns`: a quick return/volatility profile for MANY price series at once, computed in parallel.
//! (The Python engine does deep analysis of one series; this does light analysis of thousands.)
//! Results come back in the order the series were sent, identical for any number of workers.

use crate::computing::{parallel_map, Deadline};
use crate::errors::{EngineError, Result};
use crate::json::{obj, Json};
use crate::validate::{label, opt_str, series, stable_sum, MAX_POINTS};

pub const MAX_SERIES: usize = 10_000;
pub const MAX_TOTAL_POINTS: usize = 5_000_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    pub points: usize,
    pub total_return_percent: f64,
    pub mean_return_percent: f64,
    pub stdev_percent: Option<f64>,
    pub best_return_percent: f64,
    pub best_index: usize,
    pub worst_return_percent: f64,
    pub worst_index: usize,
    pub positive_periods_percent: f64,
}

/// `log = false`: simple returns (p1/p0 - 1). `log = true`: log returns ln(p1/p0). Both in percent.
pub fn profile(prices: &[f64], log: bool) -> Profile {
    let n = prices.len() - 1;
    let rets: Vec<f64> = (1..prices.len())
        .map(|i| {
            let r = prices[i] / prices[i - 1];
            100.0 * if log { r.ln() } else { r - 1.0 }
        })
        .collect();
    let mean = stable_sum(rets.iter().copied()) / n as f64;
    let stdev = if n >= 2 {
        let ss = stable_sum(rets.iter().map(|r| (r - mean) * (r - mean)));
        Some((ss / (n as f64 - 1.0)).sqrt())
    } else {
        None
    };
    let (mut best, mut worst) = (0usize, 0usize);
    for (i, r) in rets.iter().enumerate() {
        if *r > rets[best] {
            best = i;
        }
        if *r < rets[worst] {
            worst = i;
        }
    }
    let first_last = prices[prices.len() - 1] / prices[0];
    Profile {
        points: prices.len(),
        total_return_percent: 100.0 * if log { first_last.ln() } else { first_last - 1.0 },
        mean_return_percent: mean,
        stdev_percent: stdev,
        best_return_percent: rets[best],
        best_index: best + 1,
        worst_return_percent: rets[worst],
        worst_index: worst + 1,
        positive_periods_percent: 100.0 * rets.iter().filter(|r| **r > 0.0).count() as f64 / n as f64,
    }
}

pub fn batch_returns(args: &Json, workers: usize, deadline: &Deadline) -> Result<Json> {
    let kind = opt_str(args, "kind", "simple", &["simple", "log"])?;
    let log = kind == "log";
    let sets = args
        .get("datasets")
        .and_then(Json::as_object)
        .ok_or_else(|| EngineError::invalid("datasets must be an object: {name: [prices]}"))?;
    if sets.is_empty() || sets.len() > MAX_SERIES {
        return Err(EngineError::invalid(format!("datasets must contain 1 to {MAX_SERIES} named lists")));
    }
    let mut named: Vec<(&str, Vec<f64>)> = Vec::with_capacity(sets.len());
    let mut total = 0usize;
    for (name, values) in sets {
        label(name, "dataset name")?;
        let p = series(values, &format!("datasets[{name}]"), 3, MAX_POINTS, true)?;
        total += p.len();
        if total > MAX_TOTAL_POINTS {
            return Err(EngineError::new(crate::errors::Code::TooLarge, format!("more than {MAX_TOTAL_POINTS} values in total")));
        }
        named.push((name.as_str(), p));
        deadline.check()?;
    }
    let used = workers.max(1).min(named.len());
    let profiles = parallel_map(&named, workers, |(_, p)| {
        deadline.check()?;
        Ok(profile(p, log))
    })?;
    let results: Vec<(String, Json)> = named
        .iter()
        .zip(profiles)
        .map(|((name, _), p)| {
            (
                name.to_string(),
                obj(vec![
                    ("points", Json::usize(p.points)),
                    ("total_return_percent", Json::Num(p.total_return_percent)),
                    ("mean_return_percent", Json::Num(p.mean_return_percent)),
                    ("stdev_percent", Json::opt(p.stdev_percent)),
                    ("best_return_percent", Json::Num(p.best_return_percent)),
                    ("best_price_index", Json::usize(p.best_index)),
                    ("worst_return_percent", Json::Num(p.worst_return_percent)),
                    ("worst_price_index", Json::usize(p.worst_index)),
                    ("positive_periods_percent", Json::Num(p.positive_periods_percent)),
                ]),
            )
        })
        .collect();
    Ok(obj(vec![
        ("kind", Json::str(kind)),
        ("series_count", Json::usize(named.len())),
        ("total_points", Json::usize(total)),
        ("workers_used", Json::usize(used)),
        ("results", Json::Obj(results)),
        (
            "note",
            Json::str(
                "Per-period returns in percent from the prices you supplied; *_price_index is the position (0 = first price) of the \
                 price that ended the best/worst period. Historical description only, not a forecast.",
            ),
        ),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    #[test]
    fn known_answer() {
        let p = profile(&[100.0, 110.0, 99.0, 108.9], false);
        assert!((p.total_return_percent - 8.9).abs() < 1e-12);
        assert!((p.mean_return_percent - (10.0 - 10.0 + 10.0) / 3.0).abs() < 1e-12);
        assert_eq!((p.best_index, p.worst_index), (1, 2));
        assert!((p.positive_periods_percent - 200.0 / 3.0).abs() < 1e-12);
        let sd = p.stdev_percent.unwrap();
        let m = 10.0 / 3.0;
        let expect: f64 = ((10.0f64 - m).powi(2) + (-10.0f64 - m).powi(2) + (10.0f64 - m).powi(2)) / 2.0;
        assert!((sd - expect.sqrt()).abs() < 1e-12);
    }

    #[test]
    fn log_returns_add_up() {
        let p = profile(&[100.0, 110.0, 121.0], true);
        assert!((p.total_return_percent - 100.0 * (1.21f64).ln()).abs() < 1e-12);
        assert!((p.mean_return_percent * 2.0 - p.total_return_percent).abs() < 1e-12);
    }

    #[test]
    fn constant_series_has_zero_volatility() {
        let p = profile(&[5.0, 5.0, 5.0, 5.0], false);
        assert_eq!(p.stdev_percent, Some(0.0));
        assert_eq!(p.positive_periods_percent, 0.0);
    }

    fn many(n: usize) -> Json {
        Json::Obj(
            (0..n)
                .map(|i| {
                    let prices: Vec<Json> = (0..50).map(|t| Json::Num(100.0 + (i as f64) * 0.1 + ((t * (i + 3)) % 11) as f64)).collect();
                    (format!("s{i}"), Json::Arr(prices))
                })
                .collect(),
        )
    }

    #[test]
    fn same_output_for_any_worker_count_and_order_kept() {
        let args = obj(vec![("datasets", many(200))]);
        let one = batch_returns(&args, 1, &Deadline::none()).unwrap();
        for w in [2, 4, 8, 64] {
            assert_eq!(batch_returns(&args, w, &Deadline::none()).unwrap().get("results"), one.get("results"), "workers {w}");
        }
        let names: Vec<_> = one.get("results").unwrap().as_object().unwrap().iter().map(|(k, _)| k.clone()).collect();
        assert_eq!(names[0], "s0");
        assert_eq!(names[199], "s199");
        assert_eq!(batch_returns(&args, 8, &Deadline::none()).unwrap().get("workers_used").unwrap().as_f64(), Some(8.0));
    }

    #[test]
    fn refuses_bad_input() {
        let bad = [
            "{}", "{\"datasets\":{}}", "{\"datasets\":[1,2,3]}", "{\"datasets\":{\"a\":[1,2]}}",
            "{\"datasets\":{\"a\":[1,0,3]}}", "{\"datasets\":{\"a\":[1,-2,3]}}", "{\"datasets\":{\"a\":[1,null,3]}}",
            "{\"datasets\":{\"\":[1,2,3]}}", "{\"datasets\":{\"a\":[1,2,3]},\"kind\":\"weird\"}",
        ];
        for text in bad {
            assert!(batch_returns(&parse(text).unwrap(), 2, &Deadline::none()).is_err(), "{text}");
        }
    }

    #[test]
    fn total_size_is_limited() {
        let big: Vec<Json> = (0..MAX_POINTS).map(|i| Json::Num(1.0 + (i % 5) as f64)).collect();
        let sets: Vec<(String, Json)> = (0..51).map(|i| (format!("s{i}"), Json::Arr(big.clone()))).collect();
        let e = batch_returns(&obj(vec![("datasets", Json::Obj(sets))]), 4, &Deadline::none()).unwrap_err();
        assert_eq!(e.code, crate::errors::Code::TooLarge);
    }

    #[test]
    fn expired_deadline_stops_the_work() {
        let d = Deadline::after(std::time::Duration::from_millis(0));
        std::thread::sleep(std::time::Duration::from_millis(2));
        let e = batch_returns(&obj(vec![("datasets", many(10))]), 2, &d).unwrap_err();
        assert_eq!(e.code, crate::errors::Code::Timeout);
    }
}
