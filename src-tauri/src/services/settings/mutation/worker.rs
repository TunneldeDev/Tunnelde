//! One worker owns serialization through durable commit and native publication.
use super::Writer;
use crate::{
    error::AppResult,
    services::operations::{Budget, Cancellation, Errors},
    state::AppState,
};
use std::sync::LazyLock;
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, MutexGuard};

pub(super) const ERRORS: Errors = Errors {
    domain: "settings.operation",
    busy: "settings.operation.busy",
    cancelled: "settings.operation.cancelled",
    failed: "settings.operation.unavailable",
};

pub(crate) async fn run<T: Send + 'static>(
    app: &AppHandle,
    operation: impl FnOnce(Writer<'_>) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
    let app = app.clone();
    WORKERS
        .blocking(move |cancellation| {
            let state = app.state::<AppState>();
            locked(&state.settings_commit, cancellation, |serial| {
                operation(Writer {
                    app: &app,
                    state: &state,
                    _serial: serial,
                    cancellation,
                })
            })
        })
        .await
}

pub(super) fn locked<T>(
    serial: &Mutex<()>,
    cancellation: &Cancellation,
    operation: impl FnOnce(MutexGuard<'_, ()>) -> AppResult<T>,
) -> AppResult<T> {
    cancellation.check()?;
    let serial = serial.blocking_lock();
    cancellation.check()?;
    operation(serial)
}

#[cfg(test)]
mod tests;
