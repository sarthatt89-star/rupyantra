//! Engine identity. The version comes from Cargo.toml at compile time, so it can never drift from the build.

pub const ENGINE: &str = "rust";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
