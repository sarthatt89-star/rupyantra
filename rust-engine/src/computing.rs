//! Safe parallelism and deadlines.
//!
//! `parallel_map` splits a list of independent jobs over scoped threads (standard library only) and returns the answers in
//! the ORIGINAL order, so the result never depends on how many workers ran or which finished first.
//! Deadlines are cooperative: calculations call `Deadline::check()` between units of work. A calculation that never checks
//! cannot be interrupted, which is why every long loop in this engine does check.

use crate::errors::{Code, EngineError, Result};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct Deadline {
    end: Option<Instant>,
}

impl Deadline {
    pub fn after(d: Duration) -> Deadline {
        Deadline { end: Instant::now().checked_add(d) }
    }
    pub fn none() -> Deadline {
        Deadline { end: None }
    }
    pub fn check(&self) -> Result<()> {
        match self.end {
            Some(end) if Instant::now() >= end => {
                Err(EngineError::new(Code::Timeout, "the calculation took too long and was stopped"))
            }
            _ => Ok(()),
        }
    }
}

pub fn default_workers() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).min(8)
}

/// Apply `f` to every item. Output order = input order. The first error (in input order) is returned.
pub fn parallel_map<T, R, F>(items: &[T], workers: usize, f: F) -> Result<Vec<R>>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> Result<R> + Sync,
{
    let workers = workers.max(1).min(items.len().max(1));
    if workers == 1 || items.len() < 2 {
        return items.iter().map(&f).collect();
    }
    let chunk = items.len().div_ceil(workers);
    let f = &f;
    let parts: Vec<std::thread::Result<Result<Vec<R>>>> = std::thread::scope(|s| {
        let handles: Vec<_> = items
            .chunks(chunk)
            .map(|c| s.spawn(move || c.iter().map(f).collect::<Result<Vec<R>>>()))
            .collect();
        handles.into_iter().map(|h| h.join()).collect()
    });
    let mut out = Vec::with_capacity(items.len());
    for part in parts {
        match part {
            Ok(Ok(v)) => out.extend(v),
            Ok(Err(e)) => return Err(e),
            Err(panic) => std::panic::resume_unwind(panic), // a bug in a job: the engine turns it into INTERNAL_ERROR
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_answer_for_any_worker_count_and_in_order() {
        let items: Vec<u64> = (0..1000).collect();
        let expected: Vec<u64> = items.iter().map(|x| x * x + 1).collect();
        for w in [1, 2, 3, 7, 16, 5000] {
            assert_eq!(parallel_map(&items, w, |x| Ok(x * x + 1)).unwrap(), expected, "workers {w}");
        }
    }

    #[test]
    fn empty_and_single_inputs() {
        let none: Vec<u8> = vec![];
        assert!(parallel_map(&none, 4, |x| Ok(*x)).unwrap().is_empty());
        assert_eq!(parallel_map(&[5u8], 4, |x| Ok(*x)).unwrap(), vec![5]);
    }

    #[test]
    fn first_error_in_input_order_wins() {
        let items: Vec<u32> = (0..100).collect();
        let r = parallel_map(&items, 8, |x| if *x >= 10 { Err(EngineError::invalid(format!("bad {x}"))) } else { Ok(*x) });
        assert_eq!(r.unwrap_err().message, "bad 10");
    }

    #[test]
    fn a_panic_is_not_swallowed() {
        let items: Vec<u32> = (0..50).collect();
        let r = std::panic::catch_unwind(|| parallel_map(&items, 4, |x| if *x == 30 { panic!("boom") } else { Ok(*x) }));
        assert!(r.is_err());
    }

    #[test]
    fn deadline_expires() {
        assert!(Deadline::none().check().is_ok());
        let d = Deadline::after(Duration::from_millis(20));
        assert!(d.check().is_ok());
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(d.check().unwrap_err().code, Code::Timeout);
    }
}
