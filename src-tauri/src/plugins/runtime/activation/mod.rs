//! Lifecycle entry points and the dependency planner have distinct ownership.
//! Planning never authorizes a plugin or starts an engine. Keep it internal until
//! the executor checks complete approval, live leases, and frontend readiness.
mod contracts;
pub(in crate::plugins) mod execution;
pub use contracts::StartPermit;
#[cfg(test)]
mod graph;
pub(in crate::plugins) mod limits;
#[cfg(test)]
use limits::*;

#[cfg(test)]
mod tests;
