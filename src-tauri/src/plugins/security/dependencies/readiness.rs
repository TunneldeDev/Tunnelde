//! Readiness belongs to the existing policy, with subscriptions established
//! before inspection so initialize/frontend acknowledgements cannot be lost.
use std::future::Future;

use tokio::time::Instant;

use super::{
    super::{Lease, PluginSecurity},
    model::Phase,
};
use crate::error::{AppError, AppResult};

impl PluginSecurity {
    fn ready_identity(&self, lease: &Lease) -> AppResult<Option<uuid::Uuid>> {
        let policy = self.policy();
        Self::authorize_policy(
            &policy,
            &lease.id,
            &lease.fingerprint,
            &lease.permissions,
            None,
            Some(lease.generation),
        )?;
        let binding = policy
            .runtimes
            .0
            .get(&lease.id)
            .filter(|binding| binding.matches(lease))
            .ok_or_else(|| AppError::validation("plugin.notRunning"))?;
        Ok((binding.phase == Phase::Ready).then_some(binding.readiness_id))
    }

    /// Wait for this exact runtime, never for a replacement bearing the same
    /// package id. Dropping a caller's wait only removes its subscription.
    pub(in crate::plugins) async fn wait_ready(
        &self,
        lease: &Lease,
        deadline: Instant,
    ) -> AppResult<()> {
        let mut changed = self.changed.subscribe();
        loop {
            if self.ready_identity(lease)?.is_some() {
                return Ok(());
            }
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(AppError::validation("plugin.timeout"));
                }
                _ = changed.changed() => {}
            }
        }
    }

    /// Once admitted, loss of readiness cancels the invocation instead of
    /// letting it finish against a newly activated frontend module.
    pub(in crate::plugins) async fn guard_ready<T>(
        &self,
        lease: &Lease,
        operation: impl Future<Output = AppResult<T>>,
    ) -> AppResult<T> {
        let mut changed = self.changed.subscribe();
        let original = self
            .ready_identity(lease)?
            .ok_or_else(|| AppError::validation("plugin.notRunning"))?;
        let check = || {
            if self.ready_identity(lease)? == Some(original) {
                Ok(())
            } else {
                Err(AppError::validation("plugin.notRunning"))
            }
        };
        check()?;
        tokio::pin!(operation);
        loop {
            tokio::select! {
                biased;
                _ = changed.changed() => { check()?; }
                result = &mut operation => { check()?; return result; }
            }
        }
    }
}
