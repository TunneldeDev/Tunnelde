//! Lifecycle entry points and the dependency planner have distinct ownership.
//! Planning never authorizes a plugin or starts an engine. Keep it internal until
//! the executor checks complete approval, live leases, and frontend readiness.
mod contracts;
pub(in crate::plugins) mod execution;
pub use contracts::{ActivationPlan, Dependency as PluginDependency, PackageReview, StartPermit};
mod graph;
pub(in crate::plugins) mod limits;
use limits::*;

pub(in crate::plugins) fn validate_dependencies(
    owner: &str,
    dependencies: &[PluginDependency],
) -> crate::error::AppResult<()> {
    graph::validate_declaration(owner, dependencies).map_err(contracts::Issue::into_error)
}

#[cfg(test)]
mod tests;
