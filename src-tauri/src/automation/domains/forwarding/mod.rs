//! Independent read-only local forwarding contract over the shared service.
mod contract;
mod mutations;
mod schema;
mod start;
#[cfg(test)]
pub(super) mod tests;

use crate::automation::{contract::Failure, runtime::blocking};
use crate::{
    db::Database, error::AppResult, services::forwarding, ssh::forward::ForwardRegistry,
    state::AppState,
};
pub(super) use schema::method;
pub(super) fn methods() -> Vec<Value> {
    let mut methods = vec![method()];
    methods.extend(mutations::methods());
    methods.extend(start::methods());
    methods
}
use serde_json::Value;
use std::sync::{Arc, LazyLock};
use tauri::{AppHandle, Manager};
use tokio::sync::Semaphore;

pub(super) async fn call(app: &AppHandle, method: &str, params: Value) -> Result<Value, Failure> {
    if matches!(
        method,
        "forwards.start" | "forwards.startStatus" | "forwards.cancelStart"
    ) {
        return start::call(app, method, params);
    }
    if method != "forwards.list" {
        return mutations::call(app, method, params).await;
    }
    let request = contract::parse(params)?;
    static CAPACITY: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(4)));
    let operation = blocking::Read::admit(
        CAPACITY.clone(),
        "automation.forwards.cancelled",
        "Forwarding readers are busy; retry after the current reads complete",
    )?;
    let ticket = operation.ticket();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        project(&state.db, &state.forwards, request, || ticket.check())
    })
    .await
    .map_err(|_| {
        Failure::new(
            "internal",
            "Cannot complete forwarding reading; see application logs",
        )
    })?
}

fn project(
    db: &Database,
    registry: &ForwardRegistry,
    request: contract::Request,
    check: impl Fn() -> AppResult<()>,
) -> Result<Value, Failure> {
    let records = forwarding::query::page(db, registry, &request.after, request.limit + 1, check)
        .map_err(|error| {
        tracing::warn!(target: "automation.forwards", error_code=error.code(),
                "Cannot read the saved forwarding page");
        Failure::new(
            "operation_rejected",
            "Cannot read forwarding rules; retry or inspect application logs",
        )
    })?;
    contract::page(records, request.limit)
}
