//! Recovery consent and bounded metadata publication, separate from execution.
use super::operation::Operation;
use crate::{
    error::{AppError, AppResult},
    plugins::{
        api::{authorize, encode, frontend_request, HostContext},
        security::Lease,
    },
    state::AppState,
    storage::recovery::{self, contracts::*},
};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
const READ: &[&str] = &["storage.recovery.read"];
const WRITE: &[&str] = &["storage.recovery.read", "storage.recovery.write"];
fn parse<T: serde::de::DeserializeOwned>(params: Value) -> AppResult<T> {
    serde_json::from_value(params).map_err(|_| AppError::validation("plugin.api.invalid:params"))
}
fn redacted(error: AppError) -> AppError {
    let message = error.to_string();
    if message.starts_with("storage.")
        && message
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.')
        || message.starts_with("pluginSecurity.")
        || message == "plugin.api.cancelled"
    {
        return error;
    }
    AppError::validation("storage.recovery.unavailable")
}
pub(super) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let operation = Operation::admit()?;
    let paths = context.app.state::<AppState>().storage.clone();
    if method == "storage.recovery.observe" {
        let request = parse(params)?;
        let context = context.clone();
        let ticket = operation.ticket();
        return tauri::async_runtime::spawn_blocking(move || {
            recovery::observe(&paths, request, || {
                ticket.check()?;
                authorize(&context, READ)
            })
            .and_then(encode)
            .map_err(redacted)
        })
        .await
        .map_err(|_| AppError::internal("storage.recovery.unavailable"))?;
    }
    if method != "storage.recovery.request" {
        return Err(AppError::validation("plugin.api.unknownMethod"));
    }
    let request: Request = parse(params)?;
    let worker = context.clone();
    let worker_paths = paths.clone();
    let ticket = operation.ticket();
    let expected = request.revision.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        let snapshot = recovery::observe(&worker_paths, Observe::default(), || {
            ticket.check()?;
            authorize(&worker, WRITE)
        })?
        .snapshot
        .ok_or_else(|| AppError::internal("storage.recovery.unavailable"))?;
        if snapshot.revision != expected {
            return Err(AppError::validation("storage.recovery.conflict"));
        }
        if snapshot.pending.is_none() {
            return Err(AppError::validation("storage.recovery.noPendingPlan"));
        }
        Ok(snapshot)
    })
    .await
    .map_err(|_| AppError::internal("storage.recovery.unavailable"))?
    .map_err(redacted)?;
    let confirmed = frontend_request(
        context,
        method,
        json!({"snapshot":snapshot,"action":request.action}),
    )
    .await?;
    if !matches!(confirmed, Value::Bool(_)) {
        return Err(AppError::validation("plugin.api.invalidResponse"));
    }
    let worker = context.clone();
    let ticket = operation.ticket();
    tauri::async_runtime::spawn_blocking(move || {
        let check = || {
            ticket.check()?;
            authorize(&worker, WRITE)
        };
        let snapshot = if confirmed == Value::Bool(false) {
            recovery::observe(&paths, Observe::default(), check)?
                .snapshot
                .ok_or_else(|| AppError::internal("storage.recovery.unavailable"))?
        } else {
            let state = worker.app.state::<AppState>();
            let lease = Lease {
                id: worker.id.clone(),
                fingerprint: worker.fingerprint.clone(),
                permissions: worker.permissions.clone(),
                generation: worker.generation,
            };
            let snapshot = recovery::request(
                &paths,
                request,
                check,
                || ticket.commit(),
                |save| state.plugins.security.with_authorized(&lease, WRITE, save),
            )?;
            let _ = worker
                .app
                .emit("plugin://domain-changed", json!({"domain":"storage"}));
            snapshot
        };
        encode(RequestResult {
            version: 1,
            outcome: if confirmed == Value::Bool(false) {
                "dismissed"
            } else {
                "restartScheduled"
            },
            snapshot,
        })
    })
    .await
    .map_err(|_| AppError::internal("storage.recovery.unavailable"))?
    .map_err(redacted)
}
