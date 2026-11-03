//! `rolling_stats`: rolling mean and sample standard deviation over a window, in one pass (O(n)).
//! The running values are recomputed exactly every `max(window, 1024)` steps so rounding drift cannot build up.

use crate::computing::Deadline;
use crate::errors::Result;
use crate::json::{obj, Json};
use crate::validate::{series, stable_sum, usize_in, MAX_POINTS};

fn exact(window: &[f64]) -> (f64, f64) {
    let n = window.len() as f64;
    let mean = stable_sum(window.iter().copied()) / n;
    let m2 = stable_sum(window.iter().map(|x| (x - mean) * (x - mean)));
    (mean, m2)
}

/// Returns (means, standard deviations), one per full window.
pub fn rolling(values: &[f64], window: usize, deadline: &Deadline) -> Result<(Vec<f64>, Vec<f64>)> {
    let count = values.len() - window + 1;
    let w = window as f64;
    let refresh = window.max(1024);
    let mut means = Vec::with_capacity(count);
    let mut stds = Vec::with_capacity(count);
    let (mut mean, mut m2) = exact(&values[..window]);
    means.push(mean);
    stds.push((m2.max(0.0) / (w - 1.0)).sqrt());
    for i in 1..count {
        if i % refresh == 0 {
            deadline.check()?;
            let (m, s) = exact(&values[i..i + window]);
            mean = m;
            m2 = s;
        } else {
            let (old, new) = (values[i - 1], values[i + window - 1]);
            let new_mean = mean + (new - old) / w;
            m2 += (new - old) * (new - new_mean + old - mean);
            mean = new_mean;
        }
        means.push(mean);
        stds.push((m2.max(0.0) / (w - 1.0)).sqrt());
    }
    Ok((means, stds))
}

pub fn rolling_stats(args: &Json, deadline: &Deadline) -> Result<Json> {
    let values = series(args.get("values").unwrap_or(&Json::Null), "values", 3, MAX_POINTS, false)?;
    let window = usize_in(args.get("window").unwrap_or(&Json::Null), "window", 2, values.len())?;
    let (means, stds) = rolling(&values, window, deadline)?;
    Ok(obj(vec![
        ("observations", Json::usize(values.len())),
        ("window", Json::usize(window)),
        ("windows_computed", Json::usize(means.len())),
        ("rolling_mean", Json::Arr(means.into_iter().map(Json::Num).collect())),
        ("rolling_std_dev", Json::Arr(stds.into_iter().map(Json::Num).collect())),
        (
            "note",
            Json::str("Element k describes values[k .. k+window-1]. Sample standard deviation (n-1), in the units of your values."),
        ),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    fn naive(values: &[f64], window: usize) -> (Vec<f64>, Vec<f64>) {
        let (mut m, mut s) = (vec![], vec![]);
        for w in values.windows(window) {
            let (mean, m2) = exact(w);
            m.push(mean);
            s.push((m2 / (window as f64 - 1.0)).sqrt());
        }
        (m, s)
    }

    fn lcg(seed: u64, n: usize) -> Vec<f64> {
        let mut x = seed;
        (0..n)
            .map(|_| {
                x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                ((x >> 11) as f64 / (1u64 << 53) as f64) * 10.0 - 5.0
            })
            .collect()
    }

    fn close(a: &[f64], b: &[f64], rel: f64) {
        assert_eq!(a.len(), b.len());
        for (i, (x, y)) in a.iter().zip(b).enumerate() {
            assert!((x - y).abs() <= rel * y.abs().max(1.0), "index {i}: {x} vs {y}");
        }
    }

    #[test]
    fn matches_the_slow_exact_method() {
        for (n, w) in [(10, 2), (100, 5), (5000, 30), (3000, 3000), (3000, 2999), (4096, 1500)] {
            let v = lcg(n as u64, n);
            let (m, s) = rolling(&v, w, &Deadline::none()).unwrap();
            let (nm, ns) = naive(&v, w);
            close(&m, &nm, 1e-11);
            close(&s, &ns, 1e-9);
        }
    }

    #[test]
    fn large_offset_data_stays_accurate() {
        let v: Vec<f64> = lcg(9, 20_000).into_iter().map(|x| 1.0e6 + x).collect();
        let (m, s) = rolling(&v, 50, &Deadline::none()).unwrap();
        let (nm, ns) = naive(&v, 50);
        close(&m, &nm, 1e-12);
        close(&s, &ns, 1e-6);
    }

    #[test]
    fn known_values() {
        let (m, s) = rolling(&[1.0, 2.0, 3.0, 4.0, 5.0], 3, &Deadline::none()).unwrap();
        assert_eq!(m, vec![2.0, 3.0, 4.0]);
        for x in s {
            assert!((x - 1.0).abs() < 1e-12);
        }
        let (_, flat) = rolling(&[7.0; 20], 4, &Deadline::none()).unwrap();
        assert!(flat.iter().all(|x| *x == 0.0), "a flat series has exactly zero deviation");
    }

    #[test]
    fn json_door_and_bad_input() {
        let r = rolling_stats(&parse("{\"values\":[1,2,3,4],\"window\":2}").unwrap(), &Deadline::none()).unwrap();
        assert_eq!(r.get("windows_computed").unwrap().as_f64(), Some(3.0));
        for bad in [
            "{}", "{\"values\":[1,2,3]}", "{\"values\":[1,2,3],\"window\":1}", "{\"values\":[1,2,3],\"window\":4}",
            "{\"values\":[1,2,3],\"window\":2.5}", "{\"values\":[1,null,3],\"window\":2}", "{\"values\":\"abc\",\"window\":2}",
        ] {
            assert!(rolling_stats(&parse(bad).unwrap(), &Deadline::none()).is_err(), "{bad}");
        }
    }

    #[test]
    fn full_size_input_is_fast_enough() {
        let v = lcg(1, MAX_POINTS);
        let t = std::time::Instant::now();
        let (m, _) = rolling(&v, 250, &Deadline::none()).unwrap();
        assert_eq!(m.len(), MAX_POINTS - 249);
        assert!(t.elapsed().as_secs() < 5);
    }
}
