//! Read-only local adapter to the shared persisted-log service.
mod schema;
#[cfg(test)]
pub(super) mod tests;

use crate::automation::contract::Failure;
use crate::automation::runtime::blocking;
use crate::{error::AppError, logs::read, state::AppState};
use serde_json::Value;
use std::sync::{Arc, LazyLock};
use tauri::{AppHandle, Manager};
use tokio::sync::Semaphore;

pub(super) use schema::method;
const OWNER: &str = "local-automation:v1";

pub(super) async fn call(app: &AppHandle, method: &str, params: Value) -> Result<Value, Failure> {
    if method != "logs.read" {
        return Err(Failure::new("unknown_method", "Unknown local log method"));
    }
    let request = parse(params)?;
    static CAPACITY: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(4)));
    let operation = blocking::Read::admit(
        CAPACITY.clone(),
        "automation.logs.cancelled",
        "Log readers are busy; retry after the current reads complete",
    )?;
    let ticket = operation.ticket();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        project(&state.log_dir, &state.db, request, || ticket.check())
    })
    .await
    .map_err(|_| {
        Failure::new(
            "internal",
            "Cannot complete log reading; see application logs",
        )
    })?
}

fn project(
    dir: &std::path::Path,
    db: &crate::db::Database,
    request: read::contracts::Request,
    check: impl Fn() -> crate::error::AppResult<()>,
) -> Result<Value, Failure> {
    read::read(dir, db, OWNER, request, check)
        .map_err(map_error)
        .and_then(|page| {
            serde_json::to_value(page)
                .map_err(|_| Failure::new("internal", "Cannot encode the log page"))
        })
}

fn parse(params: Value) -> Result<read::contracts::Request, Failure> {
    serde_json::from_value(params).map_err(|_| {
        Failure::new(
            "invalid_request",
            "Invalid log parameters; check the logs.read input schema in api.describe",
        )
    })
}

fn map_error(error: AppError) -> Failure {
    match error.original() {
        AppError::Validation(reason) if reason == "logs.read.invalidCursor" => Failure::new(
            "invalid_request",
            "Log cursor is invalid for this process, source or filter; omit it to start a new read",
        ),
        AppError::Validation(reason) if reason == "automation.logs.cancelled" => {
            Failure::new("operation_rejected", "Log reading was cancelled")
        }
        _ => {
            tracing::warn!(target: "automation.logs", error_code = error.code(),
                "Cannot read persisted logs within the available read budget");
            Failure::new(
                "operation_rejected",
                "Cannot read persisted logs; retry or inspect application logs",
            )
        }
    }
}
