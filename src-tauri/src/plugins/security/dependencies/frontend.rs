//! A native engine and a frontend module have separate readiness. A WebView
//! replacement must not inherit the previous module's successful activation.
use super::RuntimeRetirement;
use super::{lifecycle::binding, model::Phase, revocation::retire_consumers};
use crate::{
    error::{AppError, AppResult},
    plugins::security::{Lease, PluginSecurity},
};

impl PluginSecurity {
    pub(in crate::plugins) fn frontend_opened(
        &self,
        lease: &Lease,
        token: &str,
    ) -> AppResult<Vec<RuntimeRetirement>> {
        let mut policy = self.policy();
        let runtime = binding(&mut policy, lease)?;
        if !runtime.frontend || runtime.phase == Phase::Starting {
            return Err(AppError::validation("plugin.notRunning"));
        }
        if runtime.frontend_token.as_deref() == Some(token) {
            return Ok(vec![]);
        }
        runtime.frontend_token = Some(token.to_owned());
        runtime.phase = Phase::AwaitingFrontend;
        let retired = retire_consumers(&mut policy, &lease.id);
        self.notify(&mut policy);
        Ok(retired)
    }

    pub(in crate::plugins) fn frontend_ready(&self, lease: &Lease, token: &str) -> AppResult<()> {
        let mut policy = self.policy();
        let runtime = binding(&mut policy, lease)?;
        if !runtime.frontend
            || runtime.phase == Phase::Starting
            || runtime.frontend_token.as_deref() != Some(token)
        {
            return Err(AppError::validation("plugin.frontend.expired"));
        }
        runtime.phase = Phase::Ready;
        self.notify(&mut policy);
        Ok(())
    }

    pub(in crate::plugins) fn frontend_closed(
        &self,
        lease: &Lease,
        token: &str,
    ) -> Vec<RuntimeRetirement> {
        let mut policy = self.policy();
        let Some(runtime) = policy.runtimes.0.get_mut(&lease.id).filter(|runtime| {
            runtime.matches(lease) && runtime.frontend_token.as_deref() == Some(token)
        }) else {
            return vec![];
        };
        runtime.frontend_token = None;
        runtime.phase = Phase::AwaitingFrontend;
        let retired = retire_consumers(&mut policy, &lease.id);
        self.notify(&mut policy);
        retired
    }
}
