//! Calls stay bound to the engine that actually started. Looking up the latest
//! approval here would lend a replacement grant to an old process awaiting exit.
use crate::{
    error::{AppError, AppResult},
    plugins::{
        security::{self, Lease, PluginSecurity, RuntimeRetirement},
        Instance, PluginStatus,
    },
};

impl Instance {
    pub(in crate::plugins) fn running_lease(&self, security: &PluginSecurity) -> AppResult<Lease> {
        if self.retired || self.status != PluginStatus::Running {
            return Err(AppError::validation("plugin.notRunning"));
        }
        let lease = self
            .runtime_lease
            .clone()
            .filter(|lease| lease.id == self.manifest.id)
            .ok_or_else(|| AppError::validation("plugin.notRunning"))?;
        security.authorize(
            &lease.id,
            &lease.fingerprint,
            &lease.permissions,
            None,
            Some(lease.generation),
        )?;
        Ok(lease)
    }

    pub(in crate::plugins) async fn checked_runtime(
        &self,
        security: &PluginSecurity,
    ) -> AppResult<Lease> {
        let lease = self.running_lease(security)?;
        if security::fingerprint_async(self.dir.clone()).await? != lease.fingerprint {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        // Hashing can yield while another thread revokes a dependency.
        security.authorize(
            &lease.id,
            &lease.fingerprint,
            &lease.permissions,
            None,
            Some(lease.generation),
        )?;
        Ok(lease)
    }

    pub(in crate::plugins) fn belongs_to_retirement(&self, retirement: &RuntimeRetirement) -> bool {
        !self.retired
            && self.runtime_lease.as_ref().is_some_and(|lease| {
                lease.id == retirement.id && lease.generation < retirement.before_generation
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::sync::Arc;

    #[tokio::test]
    async fn engine_keeps_its_original_lease_and_rejects_changed_files_or_newer_approvals() {
        let root = std::env::temp_dir().join(format!(
            "tunnelde-runtime-admission-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("data.json"), "{}").unwrap();
        let manifest = serde_json::from_value(serde_json::json!({
            "id":"sample", "name":"Sample", "version":"1.0.0", "apiVersion":1, "runtime":"declarative",
        })).unwrap();
        let mut instance = Instance::new(manifest, root.clone());
        let security = Arc::new(PluginSecurity::default());
        let db = Database::in_memory().unwrap();
        security
            .set_permissions(
                &db,
                "sample",
                instance.fingerprint.clone(),
                &[],
                Some(vec![]),
            )
            .unwrap();
        let lease = security
            .lease("sample", instance.fingerprint.clone(), vec![])
            .unwrap();
        let pending = security.begin_runtime(&lease, &[], false).unwrap();
        security.native_ready(&lease).unwrap();
        pending.commit();
        instance.status = PluginStatus::Running;
        assert!(
            instance.running_lease(&security).is_err(),
            "status alone cannot mint an engine identity"
        );
        instance.runtime_lease = Some(lease.clone());
        assert_eq!(instance.checked_runtime(&security).await.unwrap(), lease);
        std::fs::write(root.join("data.json"), "changed").unwrap();
        assert!(instance.checked_runtime(&security).await.is_err());
        std::fs::write(root.join("data.json"), "{}").unwrap();
        let retired = security.retire_runtime("sample");
        let replacement = security
            .lease("sample", instance.fingerprint.clone(), vec![])
            .unwrap();
        assert!(
            instance.running_lease(&security).is_err(),
            "old engine cannot borrow replacement approval"
        );
        assert!(instance.belongs_to_retirement(&retired[0]));
        instance.runtime_lease = Some(replacement);
        assert!(!instance.belongs_to_retirement(&retired[0]));
        assert!(!instance.belongs_to_retirement(&RuntimeRetirement {
            id: "other".into(),
            before_generation: u64::MAX
        }));
        instance.retired = true;
        assert!(instance.running_lease(&security).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
