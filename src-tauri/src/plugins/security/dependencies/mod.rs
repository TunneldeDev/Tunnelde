//! Runtime dependency relations belong to the authorization policy lock. These
//! are edges and readiness, not a duplicate table of domain-owned resources.
mod authorization;
mod frontend;
mod lifecycle;
mod model;
mod readiness;
mod revocation;

use std::sync::Arc;

use super::{Lease, PluginSecurity};
use crate::error::AppResult;

pub(super) use authorization::validate;
pub(super) use model::RuntimeDependencies;
pub(super) use revocation::retire;
pub(in crate::plugins) use revocation::RuntimeRetirement;

pub(in crate::plugins) struct PendingRuntime {
    security: Arc<PluginSecurity>,
    lease: Option<Lease>,
    rollback: Option<Box<dyn FnOnce(Vec<RuntimeRetirement>) + Send>>,
}

impl PendingRuntime {
    pub(in crate::plugins) fn commit(mut self) {
        self.lease = None;
    }

    pub(in crate::plugins) fn on_rollback(
        mut self,
        rollback: impl FnOnce(Vec<RuntimeRetirement>) + Send + 'static,
    ) -> Self {
        self.rollback = Some(Box::new(rollback));
        self
    }
}

impl Drop for PendingRuntime {
    fn drop(&mut self) {
        let Some(lease) = self.lease.take() else {
            return;
        };
        let mut policy = self.security.policy();
        let retired = if policy.runtimes.matches(&lease) {
            let retired = retire(&mut policy, &lease.id);
            self.security.notify(&mut policy);
            retired
        } else {
            vec![]
        };
        drop(policy);
        if !retired.is_empty() {
            if let Some(rollback) = self.rollback.take() {
                rollback(retired);
            }
        }
    }
}

impl PluginSecurity {
    pub(in crate::plugins) fn begin_runtime(
        self: &Arc<Self>,
        lease: &Lease,
        required: &[Lease],
        frontend: bool,
    ) -> AppResult<PendingRuntime> {
        let mut policy = self.policy();
        let owned = lifecycle::prepare(&mut policy, lease, required, frontend)?;
        self.notify(&mut policy);
        Ok(PendingRuntime {
            security: self.clone(),
            lease: owned.then(|| lease.clone()),
            rollback: None,
        })
    }

    pub(in crate::plugins) fn native_ready(&self, lease: &Lease) -> AppResult<()> {
        let mut policy = self.policy();
        lifecycle::native_ready(&mut policy, lease)?;
        self.notify(&mut policy);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
