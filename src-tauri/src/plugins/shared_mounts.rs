use super::{
    api::{self, HostContext},
    PluginStatus,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Surface {
    plugin_id: String,
    runtime_id: String,
    view_id: String,
    contribution_id: Option<String>,
}

#[tauri::command]
pub(crate) async fn plugin_shared_mounts_action(
    app: AppHandle,
    surface: Surface,
    method: String,
    params: Value,
) -> AppResult<Value> {
    if !allowed(&method) {
        return Err(AppError::validation("plugin.api.unknownMethod"));
    }
    let state = app.state::<AppState>();
    let manager = &state.plugins;
    let instance = manager.instance(&surface.plugin_id).await?;
    let (dir, lease) = {
        let instance = instance.lock().await;
        let invalid = || AppError::validation("pluginSecurity.changed");
        let view = instance
            .manifest
            .views
            .iter()
            .find(|view| view.id == surface.view_id)
            .ok_or_else(invalid)?;
        if instance.retired
            || instance.status != PluginStatus::Running
            || instance.runtime_id.as_deref() != Some(&surface.runtime_id)
        {
            return Err(invalid());
        }
        if !super::host_details::permits_native_mounts(&instance.manifest)
            || view.provider.is_some()
            || view.kind.as_deref() != Some("sharedMounts")
        {
            return Err(invalid());
        }
        if let Some(contribution) = &surface.contribution_id {
            if !instance.manifest.host_details.iter().any(|item| {
                item.id == *contribution
                    && item.view_id == surface.view_id
                    && item.kind.as_deref() == Some("mounts")
            }) || !state
                .settings()
                .mount_host_details_selection
                .is_some_and(|s| {
                    s.plugin_id == surface.plugin_id && s.contribution_id == *contribution
                })
            {
                return Err(invalid());
            }
        }
        (
            instance.dir.clone(),
            instance.runtime_lease.clone().ok_or_else(invalid)?,
        )
    };
    let fingerprint = super::security::fingerprint_async(dir).await?;
    if fingerprint != lease.fingerprint {
        return Err(AppError::validation("pluginSecurity.changed"));
    }
    let context = HostContext {
        app: app.clone(),
        id: lease.id.clone(),
        fingerprint,
        permissions: lease.permissions.clone(),
        generation: lease.generation,
        tool_client: None,
        tool_request: None,
    };
    let additional = if surface.contribution_id.is_some() {
        &["hosts.read", "mounts.hostDetails"][..]
    } else {
        &["hosts.read"][..]
    };
    api::authorize(&context, additional)?;
    manager
        .security
        .guard(&lease, api::dispatch(&context, &method, params))
        .await
}

fn allowed(method: &str) -> bool {
    matches!(
        method,
        "mounts.rules.snapshot"
            | "mounts.groups.save"
            | "mounts.groups.remove"
            | "mounts.rules.save"
            | "mounts.rules.remove"
            | "mounts.groups.connect"
            | "mounts.groups.disconnect"
            | "mounts.groups.reconnect"
            | "mounts.runtime.connectAndStartAuto"
            | "mounts.runtime.start"
            | "mounts.runtime.stop"
            | "mounts.runtime.retry"
            | "mounts.runtime.startAll"
            | "mounts.runtime.stopAll"
            | "mounts.runtime.open"
            | "mounts.operations.get"
            | "mounts.operations.cancel"
            | "mounts.legacy.list"
            | "mounts.legacy.convert"
            | "mounts.dependencies.get"
            | "mounts.dependencies.documentation"
    )
}

#[cfg(test)]
#[test]
fn surface_allowlist_is_not_a_general_purpose_rpc() {
    assert!(allowed("mounts.rules.snapshot"));
    assert!(allowed("mounts.groups.connect"));
    assert!(!allowed("mounts.mount"));
    assert!(!allowed("ssh.exec"));
    assert!(!allowed("mounts.runtime.requestForceUnmount"));
}
