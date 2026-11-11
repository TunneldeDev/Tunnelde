use super::super::PluginsManager;
use crate::{
    error::{AppError, AppResult},
    services::plugin_configuration::contracts::schema::Declaration,
};

impl PluginsManager {
    pub(crate) fn with_configuration<T>(
        &self,
        id: &str,
        fingerprint: &str,
        operation: impl FnOnce(&Declaration) -> AppResult<T>,
    ) -> AppResult<T> {
        // Lock installed metadata through the bounded transaction, fencing replacement/removal.
        let snapshots = self
            .snapshots
            .read()
            .unwrap_or_else(|error| error.into_inner());
        let info = snapshots
            .get(id)
            .ok_or_else(|| AppError::validation("plugin.notFound"))?;
        if fingerprint != info.fingerprint {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        operation(
            info.configuration
                .as_ref()
                .ok_or_else(|| AppError::validation("configuration.notDeclared"))?,
        )
    }
}
