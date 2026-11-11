//! Bounded native reads, independent of preview tickets and plugin transports.
mod budget;
mod local;
mod remote;
mod source;

pub use local::LocalReader;
pub use remote::RemoteReader;
pub use source::Source;

// Preserve existing whole-image preview requests as well as smaller HTTP ranges.
pub const MAX_READ_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_TEXT: usize = 2 * 1024 * 1024;

#[cfg(test)]
mod tests;
