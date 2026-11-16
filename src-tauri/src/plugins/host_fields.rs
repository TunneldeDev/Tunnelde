//! Both the host form and plugin RPCs use the same revisioned metadata service.
#[cfg(test)]
mod tests;
mod worker;

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

pub(super) async fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let context = context.clone();
    let method = method.to_owned();
    worker::run(move |cancellation| call_blocking(&context, &method, params, cancellation)).await
}

fn call_blocking(
    context: &HostContext,
    method: &str,
    params: Value,
    cancellation: &crate::services::operations::Cancellation,
) -> AppResult<Value> {
    let state = context.app.state::<AppState>();
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    let result = request(
        &state.plugins,
        &state.db,
        &lease,
        method,
        params,
        cancellation,
    )?;
    if method == "hosts.setFields" {
        changed(&context.app, &context.id, &result.document);
    }
    Ok(serde_json::to_value(result)?)
}

fn request(
    plugins: &super::PluginsManager,
    db: &crate::db::Database,
    lease: &Lease,
    method: &str,
    params: Value,
    cancellation: &crate::services::operations::Cancellation,
) -> AppResult<Snapshot> {
    let permissions: &[&str] = match method {
        "hosts.getFields" => &["hosts.read"],
        "hosts.setFields" => &["hosts.read", "hosts.write"],
        _ => return Err(AppError::validation("plugin.api.unknownMethod")),
    };
    let mut params = Some(params);
    plugins.security.with_authorized_attempt(
        lease,
        permissions,
        || cancellation.check(),
        || {
            plugins.with_host_fields(&lease.id, Some(&lease.fingerprint), |schema| {
                db.try_with(|conn| {
                    cancellation.check()?;
                    let params = params.take().expect("host fields admitted once");
                    let document = if method == "hosts.getFields" {
                        let request: Read = serde_json::from_value(params)
                            .map_err(|_| AppError::validation("hostFields.invalid"))?;
                        host_fields::get_on(conn, &lease.id, &request.host_id, schema)?
                    } else {
                        let request: Update = serde_json::from_value(params)
                            .map_err(|_| AppError::validation("hostFields.invalid"))?;
                        cancellation.commit()?;
                        host_fields::replace_on(conn, &lease.id, schema, request)?
                    };
                    Ok(Snapshot {
                        schema: schema.clone(),
                        document,
                    })
                })
            })
        },
    )
}

/// Editing inert manifest fields neither executes a plugin nor grants it access.
#[tauri::command]
pub async fn host_fields_get(
    app: AppHandle,
    plugin_id: String,
    host_id: String,
) -> AppResult<Snapshot> {
    worker::run(move |cancellation| {
        let state = app.state::<AppState>();
        loop {
            cancellation.check()?;
            let result = state.plugins.with_host_fields(&plugin_id, None, |schema| {
                state.db.try_with(|conn| {
                    cancellation.check()?;
                    Ok(Snapshot {
                        schema: schema.clone(),
                        document: host_fields::get_on(conn, &plugin_id, &host_id, schema)?,
                    })
                })
            })?;
            if let Some(result) = result {
                return Ok(result);
            }
            std::thread::sleep(std::time::Duration::from_millis(4));
        }
    })
    .await
}

#[tauri::command]
pub async fn host_fields_update(
    app: AppHandle,
    plugin_id: String,
    update: Update,
) -> AppResult<Snapshot> {
    worker::run(move |cancellation| {
        let state = app.state::<AppState>();
        let mut update = Some(update);
        let snapshot = loop {
            cancellation.check()?;
            let result = state.plugins.with_host_fields(&plugin_id, None, |schema| {
                state.db.try_with(|conn| {
                    cancellation.commit()?;
                    Ok(Snapshot {
                        schema: schema.clone(),
                        document: host_fields::replace_on(
                            conn,
                            &plugin_id,
                            schema,
                            update.take().expect("host fields admitted once"),
                        )?,
                    })
                })
            })?;
            if let Some(result) = result {
                break result;
            }
            std::thread::sleep(std::time::Duration::from_millis(4));
        };
        changed(&app, &plugin_id, &snapshot.document);
        Ok(snapshot)
    })
    .await
}
