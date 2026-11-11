//! Ownership adapters for the shared declarative configuration service.
mod events;
mod manifest;
pub mod native;
pub(crate) mod rpc;
#[cfg(test)]
#[path = "tests/ownership.rs"]
mod tests;
