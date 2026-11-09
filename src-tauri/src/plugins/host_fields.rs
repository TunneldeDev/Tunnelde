//! Both the host form and plugin RPCs use the same revisioned metadata service.
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::{api::HostContext, security::Lease};
use crate::{
    error::{AppError, AppResult},
    services::host_fields::{self, Document, Snapshot, Update},
    state::AppState,
};

fn changed(app: &AppHandle, plugin_id: &str, document: &Document) {
    let state = app.state::<AppState>();
    crate::logs::record(&state.db, "host.fields.update", Some(&document.host_id));
    tracing::info!(plugin_id, host_id = %document.host_id, revision = document.revision, "host metadata updated");
    let _ = app.emit(
        "hosts://fields-changed",
        json!({
            "pluginId":plugin_id, "hostId":document.host_id, "revision":document.revision,
        }),
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    host_id: String,
}

pub(super) fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let state = context.app.state::<AppState>();
    let permissions: &[&str] = match method {
        "hosts.getFields" => &["hosts.read"],
        "hosts.setFields" => &["hosts.read", "hosts.write"],
        _ => return Err(AppError::validation("plugin.api.unknownMethod")),
    };
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    let result = state
        .plugins
        .security
        .with_authorized(&lease, permissions, || {
            state
                .plugins
                .with_host_fields(&context.id, Some(&context.fingerprint), |schema| {
                    if method == "hosts.getFields" {
                        let request: Read = serde_json::from_value(params)
                            .map_err(|_| AppError::validation("hostFields.invalid"))?;
                        Ok(Snapshot {
                            schema: schema.clone(),
                            document: host_fields::get(
                                &state.db,
                                &context.id,
                                &request.host_id,
                                schema,
                            )?,
                        })
                    } else {
                        let request: Update = serde_json::from_value(params)
                            .map_err(|_| AppError::validation("hostFields.invalid"))?;
                        Ok(Snapshot {
                            schema: schema.clone(),
                            document: host_fields::replace(
                                &state.db,
                                &context.id,
                                schema,
                                request,
                            )?,
                        })
                    }
                })
        })?;
    if method == "hosts.setFields" {
        changed(&context.app, &context.id, &result.document);
    }
    Ok(serde_json::to_value(result)?)
}

/// Editing inert manifest fields neither executes a plugin nor grants it access.
#[tauri::command]
pub fn host_fields_get(app: AppHandle, plugin_id: String, host_id: String) -> AppResult<Snapshot> {
    let state = app.state::<AppState>();
    state.plugins.with_host_fields(&plugin_id, None, |schema| {
        Ok(Snapshot {
            schema: schema.clone(),
            document: host_fields::get(&state.db, &plugin_id, &host_id, schema)?,
        })
    })
}

#[tauri::command]
pub fn host_fields_update(
    app: AppHandle,
    plugin_id: String,
    update: Update,
) -> AppResult<Snapshot> {
    let state = app.state::<AppState>();
    let snapshot = state.plugins.with_host_fields(&plugin_id, None, |schema| {
        Ok(Snapshot {
            schema: schema.clone(),
            document: host_fields::replace(&state.db, &plugin_id, schema, update)?,
        })
    })?;
    changed(&app, &plugin_id, &snapshot.document);
    Ok(snapshot)
}
