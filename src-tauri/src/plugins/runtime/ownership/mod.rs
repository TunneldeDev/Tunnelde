//! Runtime-owned reservations; disposal stays with each domain.
mod identity;
mod registry;
mod reservation;
pub(in crate::plugins) use identity::{Ownership, Scope};
pub(in crate::plugins) use registry::Registry;
#[cfg(test)]
#[path = "tests/registry.rs"]
mod tests;
