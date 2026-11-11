use serde_json::Value;

use crate::{
    error::{AppError, AppResult},
    plugins::{security::Lease, Instance, PluginStatus, PluginsManager},
};

impl PluginsManager {
    /// No await precedes identity capture: an old IPC may never borrow a later
    /// approval, even when the replacement package has identical bytes.
    pub(in crate::plugins) fn invocation_lease(
        &self,
        id: &str,
        runtime_id: &str,
    ) -> AppResult<Lease> {
        let snapshots = self
            .snapshots
            .read()
            .unwrap_or_else(|error| error.into_inner());
        let info = snapshots
            .get(id)
            .ok_or_else(|| AppError::NotFound("plugin.notFound".into()))?;
        if info.runtime == "theme" {
            return Err(AppError::validation("plugin.theme.noRuntime"));
        }
        if info.status != PluginStatus::Running {
            return Err(AppError::validation("plugin.notRunning"));
        }
        if runtime_id.is_empty() || info.runtime_id.as_deref() != Some(runtime_id) {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        let lease = self
            .security
            .lease(id, info.fingerprint.clone(), info.permissions.clone())?;
        if self.security.lease_stamp(&lease) != runtime_id {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        Ok(lease)
    }

    pub(in crate::plugins) async fn admit_invocation(
        &self,
        id: &str,
        lease: &Lease,
    ) -> AppResult<tokio::sync::OwnedMutexGuard<Instance>> {
        if lease.id != id {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        let handle = self.security.guard(lease, self.instance(id)).await?;
        let instance = self
            .security
            .guard(lease, async { Ok(handle.lock_owned().await) })
            .await?;
        let actual = self
            .security
            .guard(lease, instance.checked_runtime(&self.security))
            .await?;
        if actual != *lease {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        Ok(instance)
    }

    pub async fn run(
        &self,
        id: &str,
        command: &str,
        input: Option<Value>,
        runtime_id: &str,
    ) -> AppResult<Value> {
        let lease = self.invocation_lease(id, runtime_id)?;
        self.run_bound(id, command, input, &lease).await
    }
}
