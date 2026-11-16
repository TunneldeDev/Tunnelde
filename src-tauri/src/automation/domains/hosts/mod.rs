//! Stable saved-host projection with bounded, cancellation-aware DB readers.
#[cfg(test)]
mod tests;

use super::*;
use crate::automation::runtime::blocking;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::sync::{Arc, LazyLock};
use tokio::sync::Semaphore;

const CANCELLED: &str = "automation.hosts.cancelled";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Host {
    id: String,
    group_id: Option<String>,
    name: String,
    address: String,
    port: u16,
    username: String,
    favorite: bool,
    tags: Vec<String>,
}

pub(super) async fn call(app: &AppHandle) -> Result<Value, Failure> {
    static CAPACITY: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(4)));
    let app = app.clone();
    read(CAPACITY.clone(), move |ticket| {
        project(&app.state::<AppState>().db, || ticket.check())
    })
    .await
}

async fn read(
    capacity: Arc<Semaphore>,
    work: impl FnOnce(blocking::Ticket) -> Result<Value, Failure> + Send + 'static,
) -> Result<Value, Failure> {
    let operation = blocking::Read::admit(
        capacity,
        CANCELLED,
        "Saved-host readers are busy; retry after the current reads complete",
    )?;
    let ticket = operation.ticket();
    tauri::async_runtime::spawn_blocking(move || {
        ticket.check().map_err(map_error)?;
        work(ticket)
    })
    .await
    .map_err(|_| {
        Failure::new(
            "internal",
            "Cannot complete saved-host reading; see application logs",
        )
    })?
}

pub(super) fn project(
    db: &crate::db::Database,
    check: impl Fn() -> AppResult<()>,
) -> Result<Value, Failure> {
    let snapshot = crate::services::hosts::snapshot_checked(db, &check).map_err(map_error)?;
    let hosts: Vec<_> = snapshot
        .hosts
        .into_iter()
        .map(|host| Host {
            id: host.id,
            group_id: host.group_id,
            name: host.name,
            address: host.host,
            port: host.port,
            username: host.username,
            favorite: host.favorite,
            tags: host.tags,
        })
        .collect();
    check().map_err(map_error)?;
    // Key paths, notes, credential types and private plugin metadata are omitted.
    Ok(json!({"hosts": hosts}))
}

fn map_error(error: AppError) -> Failure {
    if matches!(error.original(), AppError::Validation(reason) if reason == CANCELLED) {
        return Failure::new("operation_rejected", "Saved-host reading was cancelled");
    }
    tracing::error!(target: "automation.hosts", error_code = error.code(), %error, "Cannot list saved hosts");
    Failure::new("internal", "Cannot read saved hosts; see application logs")
}
