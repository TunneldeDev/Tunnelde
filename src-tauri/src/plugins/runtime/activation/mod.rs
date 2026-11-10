//! Lifecycle entry points and the dependency planner have distinct ownership.
//! Planning never authorizes a plugin or starts an engine. Keep it internal until
//! the executor checks complete approval, live leases, and frontend readiness.
#[cfg(test)]
mod contracts;
mod execution;
#[cfg(test)]
mod graph;
pub(in crate::plugins) mod limits;
#[cfg(test)]
use limits::*;

#[cfg(test)]
mod tests;
