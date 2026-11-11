//! API transport and approval around the native storage service.
use crate::{
    error::{AppError, AppResult},
    plugins::{
        api::{authorize, encode, frontend_request, HostContext},
        security::Lease,
    },
    state::AppState,
    storage::public::{self, contracts::*},
};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
mod operation;
use operation::Operation;
const READ: &[&str] = &["storage.locations.read"];
const WRITE: &[&str] = &["storage.locations.read", "storage.locations.write"];
fn parse<T: serde::de::DeserializeOwned>(params: Value) -> AppResult<T> {
    serde_json::from_value(params).map_err(|_| AppError::validation("plugin.api.invalid:params"))
}
fn redacted(error: AppError) -> AppError {
    let value = error.to_string();
    if value.starts_with("storage.")
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.')
    {
        return error;
    }
    if value.starts_with("pluginSecurity.") || value == "plugin.api.cancelled" {
        return error;
    }
    AppError::validation("storage.locations.unavailable")
}
pub(super) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let operation = Operation::admit()?;
    let paths = context.app.state::<AppState>().storage.clone();
    if method == "storage.locations.observe" {
        let request = parse(params)?;
        let context = context.clone();
        let ticket = operation.ticket();
        return tauri::async_runtime::spawn_blocking(move || {
            public::observe(&paths, request, || {
                ticket.check()?;
                authorize(&context, READ)
            })
            .and_then(encode)
            .map_err(redacted)
        })
        .await
        .map_err(|_| AppError::internal("storage.locations.unavailable"))?;
    }
    if !matches!(
        method,
        "storage.locations.schedule" | "storage.locations.cancel"
    ) {
        return Err(AppError::validation("plugin.api.unknownMethod"));
    }
    let schedule: Option<Schedule> = if method.ends_with(".schedule") {
        Some(parse(params.clone())?)
    } else {
        None
    };
    let cancel: Option<Cancel> = if schedule.is_none() {
        Some(parse(params)?)
    } else {
        None
    };
    let expected = schedule
        .as_ref()
        .map(|v| v.revision.clone())
        .or_else(|| cancel.as_ref().map(|v| v.revision.clone()))
        .ok_or_else(|| AppError::validation("plugin.api.invalid:params"))?;
    let worker = context.clone();
    let worker_paths = paths.clone();
    let ticket = operation.ticket();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        ticket.check()?;
        let normalized = schedule
            .map(|request| {
                public::prepare_schedule(&worker_paths, request, || authorize(&worker, WRITE))
            })
            .transpose()?;
        let snapshot = public::observe(&worker_paths, Observe::default(), || {
            authorize(&worker, WRITE)
        })?
        .snapshot
        .ok_or_else(|| AppError::internal("storage.locations.unavailable"))?;
        if snapshot.revision != expected {
            return Err(AppError::validation("storage.locations.conflict"));
        }
        if normalized.is_none() && snapshot.pending.is_none() {
            return Err(AppError::validation("storage.locations.noPendingPlan"));
        }
        if snapshot.recovery_required {
            return Err(AppError::validation("storage.locations.recoveryRequired"));
        }
        Ok::<_, AppError>((normalized, snapshot))
    })
    .await
    .map_err(|_| AppError::internal("storage.locations.unavailable"))?
    .map_err(redacted)?;
    let (schedule, snapshot) = prepared;
    let review = json!({"snapshot":snapshot,"changes":schedule.as_ref().map(|v|&v.changes)});
    let confirmed = frontend_request(context, method, review).await?;
    if confirmed == Value::Bool(false) {
        let worker = context.clone();
        let ticket = operation.ticket();
        return tauri::async_runtime::spawn_blocking(move || {
            let current = public::observe(&paths, Observe::default(), || {
                ticket.check()?;
                authorize(&worker, WRITE)
            })
            .map_err(redacted)?
            .snapshot
            .ok_or_else(|| AppError::internal("storage.locations.unavailable"))?;
            encode(ChangeResult {
                version: 1,
                outcome: "dismissed",
                snapshot: current,
            })
            .map_err(redacted)
        })
        .await
        .map_err(|_| AppError::internal("storage.locations.unavailable"))?;
    }
    if confirmed != Value::Bool(true) {
        return Err(AppError::validation("plugin.api.invalidResponse"));
    }
    let worker = context.clone();
    let scheduling = method.ends_with(".schedule");
    let ticket = operation.ticket();
    let result = tauri::async_runtime::spawn_blocking(move || {
        ticket.check()?;
        let state = worker.app.state::<AppState>();
        let lease = Lease {
            id: worker.id.clone(),
            fingerprint: worker.fingerprint.clone(),
            permissions: worker.permissions.clone(),
            generation: worker.generation,
        };
        let persist = |save: &dyn Fn() -> AppResult<()>| {
            state.plugins.security.with_authorized(&lease, WRITE, save)
        };
        match schedule {
            Some(request) => public::schedule(
                &paths,
                request,
                || {
                    ticket.check()?;
                    authorize(&worker, WRITE)
                },
                || ticket.commit(),
                persist,
            ),
            None => public::cancel(
                &paths,
                cancel.ok_or_else(|| AppError::validation("plugin.api.invalid:params"))?,
                || {
                    ticket.check()?;
                    authorize(&worker, WRITE)
                },
                || ticket.commit(),
                persist,
            ),
        }
        .map(|snapshot| {
            // Notify even if the transport is cancelled after publication.
            let _ = worker
                .app
                .emit("plugin://domain-changed", json!({"domain":"storage"}));
            ChangeResult {
                version: 1,
                outcome: if scheduling { "scheduled" } else { "cancelled" },
                snapshot,
            }
        })
        .and_then(encode)
        .map_err(redacted)
    })
    .await
    .map_err(|_| AppError::internal("storage.locations.unavailable"))??;
    Ok(result)
}
