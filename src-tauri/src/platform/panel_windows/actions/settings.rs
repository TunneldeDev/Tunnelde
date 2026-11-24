//! Closed first-party Settings operations. Concrete payload validation and all
//! credentials, consent and business effects remain with the main owner.
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SettingsCommand {
    pub operation: SettingsOperation,
    pub args: Vec<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) enum SettingsOperation {
    #[serde(rename = "preference")]
    Preference,
    #[serde(rename = "reset")]
    Reset,
    #[serde(rename = "section")]
    Section,
    #[serde(rename = "confirm")]
    Confirm,
    #[serde(rename = "clipboard")]
    Clipboard,
    #[serde(rename = "showOutput")]
    ShowOutput,
    #[serde(rename = "externalLink")]
    ExternalLink,
    #[serde(rename = "aboutLink")]
    AboutLink,
    #[serde(rename = "hostView")]
    HostView,
    #[serde(rename = "hostDefaults")]
    HostDefaults,
    #[serde(rename = "region")]
    Region,
    #[serde(rename = "fonts_select")]
    FontsSelect,
    #[serde(rename = "fonts_catalogue")]
    FontsCatalogue,
    #[serde(rename = "fonts_import")]
    FontsImport,
    #[serde(rename = "fonts_remove")]
    FontsRemove,
    #[serde(rename = "cssImport")]
    CssImport,
    #[serde(rename = "cssExport")]
    CssExport,
    #[serde(rename = "updateCheck")]
    UpdateCheck,
    #[serde(rename = "updateInstall")]
    UpdateInstall,
    #[serde(rename = "updateSkip")]
    UpdateSkip,
    #[serde(rename = "updateHistory")]
    UpdateHistory,
    #[serde(rename = "updateRelease")]
    UpdateRelease,
    #[serde(rename = "provider")]
    Provider,
    #[serde(rename = "mountContributor")]
    MountContributor,
    #[serde(rename = "storageRestart")]
    StorageRestart,
    #[serde(rename = "profile_load")]
    ProfileLoad,
    #[serde(rename = "profile_refresh")]
    ProfileRefresh,
    #[serde(rename = "profile_save")]
    ProfileSave,
    #[serde(rename = "profile_saveCurrent")]
    ProfileSaveCurrent,
    #[serde(rename = "profile_remove")]
    ProfileRemove,
    #[serde(rename = "profile_apply")]
    ProfileApply,
    #[serde(rename = "profile_importFile")]
    ProfileImportFile,
    #[serde(rename = "profile_exportFile")]
    ProfileExportFile,
    #[serde(rename = "network_setDefaultProxy")]
    NetworkSetDefaultProxy,
    #[serde(rename = "network_setFeatureProxy")]
    NetworkSetFeatureProxy,
    #[serde(rename = "network_removeProfile")]
    NetworkRemoveProfile,
    #[serde(rename = "network_saveProfile")]
    NetworkSaveProfile,
    #[serde(rename = "network_test")]
    NetworkTest,
    #[serde(rename = "storage_load")]
    StorageLoad,
    #[serde(rename = "storage_changeDraft")]
    StorageChangeDraft,
    #[serde(rename = "storage_schedule")]
    StorageSchedule,
    #[serde(rename = "storage_cancel")]
    StorageCancel,
    #[serde(rename = "storage_pick")]
    StoragePick,
    #[serde(rename = "storage_open")]
    StorageOpen,
    #[serde(rename = "shortcuts_setQuery")]
    ShortcutsSetQuery,
    #[serde(rename = "shortcuts_toggleFilter")]
    ShortcutsToggleFilter,
    #[serde(rename = "shortcuts_change")]
    ShortcutsChange,
    #[serde(rename = "sources_load")]
    SourcesLoad,
    #[serde(rename = "sources_change")]
    SourcesChange,
    #[serde(rename = "sources_test")]
    SourcesTest,
    #[serde(rename = "security_load")]
    SecurityLoad,
    #[serde(rename = "security_setRestricted")]
    SecuritySetRestricted,
    #[serde(rename = "security_revoke")]
    SecurityRevoke,
    #[serde(rename = "security_dismissRecovery")]
    SecurityDismissRecovery,
    #[serde(rename = "node_load")]
    NodeLoad,
    #[serde(rename = "node_check")]
    NodeCheck,
    #[serde(rename = "node_choose")]
    NodeChoose,
    #[serde(rename = "node_allowSystem")]
    NodeAllowSystem,
    #[serde(rename = "node_install")]
    NodeInstall,
    #[serde(rename = "node_cancel")]
    NodeCancel,
    #[serde(rename = "configuration_get")]
    ConfigurationGet,
    #[serde(rename = "configuration_update")]
    ConfigurationUpdate,
    #[serde(rename = "configuration_migrate")]
    ConfigurationMigrate,
    #[serde(rename = "configuration_backups")]
    ConfigurationBackups,
    #[serde(rename = "configuration_restore")]
    ConfigurationRestore,
    #[serde(rename = "configuration_deleteBackup")]
    ConfigurationDeleteBackup,
    #[serde(rename = "recovery_owners")]
    RecoveryOwners,
    #[serde(rename = "recovery_snapshot")]
    RecoverySnapshot,
    #[serde(rename = "recovery_action")]
    RecoveryAction,
    #[serde(rename = "recovery_openLog")]
    RecoveryOpenLog,
    #[serde(rename = "recovery_browse")]
    RecoveryBrowse,
}
impl SettingsCommand {
    pub fn valid(&self) -> bool {
        if matches!(self.operation, SettingsOperation::NetworkSaveProfile) {
            let Some(credential) = self
                .args
                .first()
                .and_then(|edit| edit.get("credential"))
                .and_then(Value::as_object)
            else {
                return false;
            };
            if credential.len() != 1
                || !credential
                    .get("action")
                    .and_then(Value::as_str)
                    .is_some_and(|a| matches!(a, "keep" | "forget" | "save"))
            {
                return false;
            }
        }
        self.args.len() <= 8 && serde_json::to_vec(&self.args).is_ok_and(|v| v.len() <= 1024 * 1024)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn proxy_credentials_never_enter_settings_action_jobs() {
        for credential in [
            json!({"action":"save"}),
            json!({"action":"keep"}),
            json!({"action":"forget"}),
        ] {
            let c: SettingsCommand = serde_json::from_value(json!({"operation":"network_saveProfile", "args":[{"profile":{},"credential":credential}]})).unwrap();
            assert!(c.valid());
        }
        for credential in [
            json!({"action":"save", "password":"secret"}),
            json!({"password":"secret"}),
            json!({"action":"injected"}),
            Value::Null,
        ] {
            let c: SettingsCommand = serde_json::from_value(json!({"operation":"network_saveProfile", "args":[{"profile":{},"credential":credential}]})).unwrap();
            assert!(!c.valid());
        }
    }
}
