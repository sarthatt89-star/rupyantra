//! Circuit breaker: stops hammering a service that is down, then carefully tests whether it is back.
//!
//! closed    -> normal; `failure_threshold` failures in a row open it
//! open      -> calls are refused immediately until `cooldown` has passed
//! half-open -> exactly one trial call is allowed; success closes it, failure opens it again
//! Time is passed in by the caller, so the behaviour is fully testable without sleeping.

use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Closed,
    Open,
    HalfOpen,
}

#[derive(Debug)]
pub struct CircuitBreaker {
    failure_threshold: u32,
    cooldown: Duration,
    state: State,
    consecutive_failures: u32,
    opened_at: Option<Instant>,
    trial_in_flight: bool,
}

impl CircuitBreaker {
    pub fn new(failure_threshold: u32, cooldown: Duration) -> CircuitBreaker {
        CircuitBreaker {
            failure_threshold: failure_threshold.max(1),
            cooldown,
            state: State::Closed,
            consecutive_failures: 0,
            opened_at: None,
            trial_in_flight: false,
        }
    }

    pub fn state(&self) -> State {
        self.state
    }

    /// May a call go out now? Every `true` must be followed by `record_success` or `record_failure`.
    pub fn allow(&mut self, now: Instant) -> bool {
        match self.state {
            State::Closed => true,
            State::Open => {
                let waited = self.opened_at.map(|t| now.saturating_duration_since(t)).unwrap_or_default();
                if waited >= self.cooldown {
                    self.state = State::HalfOpen;
                    self.trial_in_flight = true;
                    true
                } else {
                    false
                }
            }
            State::HalfOpen => {
                if self.trial_in_flight {
                    false
                } else {
                    self.trial_in_flight = true;
                    true
                }
            }
        }
    }

    pub fn record_success(&mut self) {
        self.state = State::Closed;
        self.consecutive_failures = 0;
        self.opened_at = None;
        self.trial_in_flight = false;
    }

    pub fn record_failure(&mut self, now: Instant) {
        self.trial_in_flight = false;
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if self.state == State::HalfOpen || self.consecutive_failures >= self.failure_threshold {
            self.state = State::Open;
            self.opened_at = Some(now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_after_threshold_then_recovers() {
        let mut b = CircuitBreaker::new(3, Duration::from_secs(30));
        let t0 = Instant::now();
        for _ in 0..2 {
            assert!(b.allow(t0));
            b.record_failure(t0);
        }
        assert_eq!(b.state(), State::Closed);
        assert!(b.allow(t0));
        b.record_failure(t0);
        assert_eq!(b.state(), State::Open);
        assert!(!b.allow(t0 + Duration::from_secs(29)), "still cooling down");
        let t1 = t0 + Duration::from_secs(31);
        assert!(b.allow(t1), "one trial call");
        assert_eq!(b.state(), State::HalfOpen);
        assert!(!b.allow(t1), "only one trial at a time");
        b.record_success();
        assert_eq!(b.state(), State::Closed);
        assert!(b.allow(t1));
    }

    #[test]
    fn failed_trial_reopens() {
        let mut b = CircuitBreaker::new(1, Duration::from_secs(10));
        let t0 = Instant::now();
        assert!(b.allow(t0));
        b.record_failure(t0);
        let t1 = t0 + Duration::from_secs(11);
        assert!(b.allow(t1));
        b.record_failure(t1);
        assert_eq!(b.state(), State::Open);
        assert!(!b.allow(t1 + Duration::from_secs(5)));
        assert!(b.allow(t1 + Duration::from_secs(11)));
    }

    #[test]
    fn a_success_resets_the_failure_count() {
        let mut b = CircuitBreaker::new(3, Duration::from_secs(10));
        let t0 = Instant::now();
        for _ in 0..2 {
            b.allow(t0);
            b.record_failure(t0);
        }
        b.allow(t0);
        b.record_success();
        for _ in 0..2 {
            b.allow(t0);
            b.record_failure(t0);
        }
        assert_eq!(b.state(), State::Closed);
    }
}
