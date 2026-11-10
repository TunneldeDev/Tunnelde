//! Installed-package planning has no process, frontend, network or approval
//! side effects. Runtime leases are captured separately from content identity.
mod admission;
mod metadata;

use super::super::contracts::Plan;
use crate::plugins::{security::Lease, StartPermit};

pub(super) struct AdmittedPackage {
    pub snapshot: crate::plugins::PluginInfo,
    pub lease: Lease,
    pub permit: StartPermit,
    pub required: Vec<Lease>,
}

pub(super) struct AdmittedPlan {
    pub root: Lease,
    pub graph: Plan,
    pub packages: Vec<AdmittedPackage>,
}

pub(super) fn failure(
    id: &str,
    stage: &'static str,
    cause: crate::error::AppError,
) -> crate::error::AppError {
    crate::error::AppError::PluginActivationPackage {
        plugin_id: id.into(),
        stage,
        cause: std::sync::Arc::new(cause),
    }
}

#[cfg(test)]
mod tests;
