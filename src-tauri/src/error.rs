use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSourceFailure {
    // Only fixed source labels and localized reason keys cross the IPC boundary.
    pub source: &'static str,
    pub reason: String,
    pub status: Option<u16>,
    pub retry_at: Option<i64>,
}

impl std::fmt::Display for UpdateSourceFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.reason)
    }
}

/// Errors surfaced to the webview. Each variant maps to a stable `code`
/// so the frontend can localize messages instead of showing raw strings.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Validation(String),
    #[error("plugin.engine.unsupported")]
    PluginEngineUnsupported {
        plugin_id: String,
        plugin_version: String,
        host_version: String,
        required: String,
    },
    #[error("plugin.frontend.sdkUnsupported")]
    PluginUiSdkUnsupported { required: String, available: String },
    #[error("sftp.backupRecoveryRequired")]
    BackupRecovery { backup: String, destination: String },
    #[error("sftp.backupUnrecognized")]
    BackupUnrecognized { backup: String, destination: String },
    #[error("sftp.backupPreserved")]
    BackupPreserved { backup: String, destination: String },
    #[error("sftp.transferArtifactUnrecognized")]
    // Recovery records are shared, but production identity checks are Windows-only.
    #[cfg_attr(not(windows), allow(dead_code))]
    TransferArtifactUnrecognized { path: String },
    #[error("sftp.transferCreationUnconfirmed")]
    TransferCreationUnconfirmed { path: String },
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Internal(String),
    #[error("{0}")]
    Update(String),
    #[error("{0}")]
    UpdateRequest(UpdateSourceFailure),
    #[error("updates.sourcesUnavailable")]
    UpdateSources(Vec<UpdateSourceFailure>),
    #[error("{0}")]
    Ssh(String),
    #[error("sftp.error: Remote move/rename failed ({from} -> {to}): {reason}")]
    RemoteRename {
        from: String,
        to: String,
        reason: String,
        status_code: Option<u32>,
        server_message: Option<String>,
    },
}

impl AppError {
    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Validation(_)
            | Self::PluginEngineUnsupported { .. }
            | Self::PluginUiSdkUnsupported { .. }
            | Self::BackupRecovery { .. }
            | Self::BackupUnrecognized { .. }
            | Self::BackupPreserved { .. }
            | Self::TransferArtifactUnrecognized { .. }
            | Self::TransferCreationUnconfirmed { .. } => "validation",
            Self::NotFound(_) => "notFound",
            Self::Db(_) => "database",
            Self::Io(_) => "io",
            Self::Internal(_) => "internal",
            Self::Update(_) | Self::UpdateRequest(_) | Self::UpdateSources(_) => "update",
            Self::Ssh(_) | Self::RemoteRename { .. } => "ssh",
        }
    }

    pub fn update_source_errors(&self) -> Option<Vec<UpdateSourceFailure>> {
        match self {
            Self::UpdateRequest(failure) => Some(vec![failure.clone()]),
            Self::UpdateSources(failures) => Some(failures.clone()),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        Self::Internal(format!("serialization failed: {value}"))
    }
}

impl From<tauri::Error> for AppError {
    fn from(value: tauri::Error) -> Self {
        Self::Internal(value.to_string())
    }
}

impl From<tauri_plugin_updater::Error> for AppError {
    fn from(value: tauri_plugin_updater::Error) -> Self {
        Self::Update(value.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let detailed = matches!(
            self,
            Self::PluginEngineUnsupported { .. }
                | Self::PluginUiSdkUnsupported { .. }
                | Self::RemoteRename { .. }
                | Self::UpdateRequest(_)
                | Self::UpdateSources(_)
        );
        let mut state = serializer.serialize_struct("AppError", if detailed { 3 } else { 2 })?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        if let Self::PluginUiSdkUnsupported {
            required,
            available,
        } = self
        {
            state.serialize_field(
                "details",
                &serde_json::json!({
                    "required": required, "available": available, "stage": "ui-sdk-compatibility"
                }),
            )?;
        }
        if let Some(failures) = self.update_source_errors() {
            state.serialize_field("details", &serde_json::json!({ "sourceErrors": failures }))?;
        }
        if let Self::PluginEngineUnsupported {
            plugin_id,
            plugin_version,
            host_version,
            required,
        } = self
        {
            state.serialize_field(
                "details",
                &serde_json::json!({
                    "pluginId": plugin_id, "pluginVersion": plugin_version,
                    "hostVersion": host_version, "required": required,
                    "stage": "compatibility"
                }),
            )?;
        }
        if let Self::RemoteRename {
            from,
            to,
            reason,
            status_code,
            server_message,
        } = self
        {
            state.serialize_field(
                "details",
                &serde_json::json!({
                    "operation": "rename", "from": from, "to": to,
                    "statusCode": status_code, "serverMessage": server_message,
                    "reason": reason,
                }),
            )?;
        }
        state.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn engine_mismatch_keeps_error_code_and_supplies_exact_compatibility_context() {
        let error = AppError::PluginEngineUnsupported {
            plugin_id: "formatter".into(),
            plugin_version: "1.8.1".into(),
            host_version: "0.32.0-beta.6".into(),
            required: ">=0.33.0".into(),
        };
        assert_eq!(error.to_string(), "plugin.engine.unsupported");
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({
                "code":"validation", "message":"plugin.engine.unsupported",
                "details":{"pluginId":"formatter","pluginVersion":"1.8.1",
                    "hostVersion":"0.32.0-beta.6","required":">=0.33.0","stage":"compatibility"}
            })
        );
        assert_eq!(
            serde_json::to_value(AppError::validation("plugin.timeout")).unwrap(),
            serde_json::json!({"code":"validation","message":"plugin.timeout"})
        );
    }
}
