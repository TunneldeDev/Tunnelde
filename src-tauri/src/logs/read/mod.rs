//! Bounded public projections over persisted logs. No caller-selected paths.
pub(crate) mod contracts;
mod cursor;
mod diagnostic;
mod operations;
mod projection;
mod service;
pub(crate) use service::read;
#[cfg(test)]
mod tests;
