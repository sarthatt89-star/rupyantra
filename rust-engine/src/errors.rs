//! One error type for the whole engine. The `code` strings are shared with the Python engine and the JS bridges.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    NotApproved,
    BadRequest,
    InvalidInput,
    TooLarge,
    Timeout,
    RateLimited,
    NonFiniteResult,
    EngineUnavailable,
    BadResponse,
    Internal,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::NotApproved => "NOT_APPROVED",
            Code::BadRequest => "BAD_REQUEST",
            Code::InvalidInput => "INVALID_INPUT",
            Code::TooLarge => "TOO_LARGE",
            Code::Timeout => "TIMEOUT",
            Code::RateLimited => "RATE_LIMITED",
            Code::NonFiniteResult => "NON_FINITE_RESULT",
            Code::EngineUnavailable => "ENGINE_UNAVAILABLE",
            Code::BadResponse => "BAD_RESPONSE",
            Code::Internal => "INTERNAL_ERROR",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EngineError {
    pub code: Code,
    pub message: String,
}

impl EngineError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        EngineError { code, message: message.into() }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(Code::InvalidInput, message)
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for EngineError {}

pub type Result<T> = std::result::Result<T, EngineError>;
