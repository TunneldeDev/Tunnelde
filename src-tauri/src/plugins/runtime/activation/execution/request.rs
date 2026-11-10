use crate::{
    error::{AppError, AppResult},
    plugins::{security::Lease, Instance, PluginsManager, StartPermit},
};

impl PluginsManager {
    pub(super) async fn admit_start(
        &self,
        id: &str,
        permit: &StartPermit,
    ) -> AppResult<(Lease, tokio::sync::OwnedMutexGuard<Instance>)> {
        let lease = self.admitted_start(id, permit)?;
        let handle = self.security.guard(&lease, self.instance(id)).await?;
        let instance = self
            .security
            .guard(&lease, async { Ok(handle.lock_owned().await) })
            .await?;
        Ok((lease, instance))
    }

    pub fn prepare_start(&self, id: &str, expected_fingerprint: &str) -> AppResult<StartPermit> {
        let lease = self.snapshot_start_lease(id, expected_fingerprint)?;
        Ok(StartPermit {
            fingerprint: lease.fingerprint.clone(),
            stamp: self.security.lease_stamp(&lease),
        })
    }

    pub(super) fn admitted_start(&self, id: &str, permit: &StartPermit) -> AppResult<Lease> {
        let lease = self.snapshot_start_lease(id, &permit.fingerprint)?;
        if permit.stamp != self.security.lease_stamp(&lease) {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        Ok(lease)
    }

    fn snapshot_start_lease(&self, id: &str, expected_fingerprint: &str) -> AppResult<Lease> {
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
        if expected_fingerprint.is_empty() || expected_fingerprint != info.fingerprint {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        self.security
            .lease(id, info.fingerprint.clone(), info.permissions.clone())
    }
}

#[cfg(test)]
mod tests;
