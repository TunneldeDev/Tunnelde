//! Interactive host-detail contributions use the same trusted module lifecycle
//! as ordinary component views. A contribution never grants API permissions.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contribution {
    pub id: String,
    pub title: String,
    pub view_id: String,
    /// Mount implementations share one host-owned surface and data model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MountHostDetailsSelection {
    pub plugin_id: String,
    pub contribution_id: String,
}

pub(super) fn validate(manifest: &super::manifest::PluginManifest) -> AppResult<()> {
    let invalid = || AppError::validation("plugin.hostDetails.invalid");
    if manifest.host_details.len() > 8 {
        return Err(invalid());
    }
    let mut ids = HashSet::new();
    for item in &manifest.host_details {
        if !super::manifest::valid_id(&item.id)
            || !ids.insert(&item.id)
            || item.title.trim().is_empty()
            || item.title.len() > 120
            || item.title.chars().any(char::is_control)
            || item.kind.as_deref().is_some_and(|kind| kind != "mounts")
            || manifest.frontend.is_none()
            || !["hosts.read", "ui.trusted"]
                .iter()
                .all(|required| manifest.permissions.iter().any(|p| p == required))
            || (item.kind.as_deref() == Some("mounts")
                && !["mounts.read", "mounts.hostDetails"]
                    .iter()
                    .all(|required| manifest.permissions.iter().any(|p| p == required)))
            || !manifest.views.iter().any(|view| {
                view.id == item.view_id
                    && view.kind.as_deref() == Some("component")
                    && view.provider.is_none()
            })
        {
            return Err(invalid());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> super::super::manifest::PluginManifest {
        serde_json::from_value(json!({
            "id":"sshfs", "name":"SSHFS", "version":"1.0.0", "apiVersion":1,
            "runtime":"frontend", "frontend":{"entry":"ui/index.mjs","sdk":"^0.1.0"},
            "permissions":["ui.trusted","hosts.read","mounts.read","mounts.hostDetails"],
            "views":[{"id":"mounts","title":"Mounts","kind":"component"}],
            "hostDetails":[{"id":"mounts","title":"Mounts","viewId":"mounts","kind":"mounts"}]
        }))
        .unwrap()
    }

    #[test]
    fn accepts_interactive_mount_contribution_and_requires_its_permissions() {
        let mut value = manifest();
        validate(&value).unwrap();
        value.permissions.retain(|p| p != "mounts.hostDetails");
        assert!(validate(&value).is_err());
        value.host_details[0].kind = None;
        validate(&value).unwrap();
    }

    #[test]
    fn rejects_missing_views_duplicate_ids_and_provider_reuse() {
        let mut value = manifest();
        value.views[0].provider = Some("forwarding".into());
        assert!(validate(&value).is_err());
        value.views.clear();
        assert!(validate(&value).is_err());
        let mut value = manifest();
        value.host_details.push(value.host_details[0].clone());
        assert!(validate(&value).is_err());
    }
}
