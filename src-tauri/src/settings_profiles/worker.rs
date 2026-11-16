//! Retained Profile catalogue operations, separate from settings activation.
use crate::{
    db::Database,
    error::AppResult,
    services::operations::{Budget, Cancellation, Errors},
    state::AppState,
};
use std::sync::LazyLock;
use tauri::{AppHandle, Manager};

const ERRORS: Errors = Errors {
    domain: "profiles.operation",
    busy: "profiles.operation.busy",
    cancelled: "profiles.operation.cancelled",
    failed: "profiles.operation.unavailable",
};

pub(super) async fn blocking<T: Send + 'static>(
    operation: impl FnOnce(&Cancellation) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
    WORKERS.blocking(operation).await
}

pub(super) async fn run<T: Send + 'static>(
    app: &AppHandle,
    operation: impl FnOnce(&Database, &Cancellation) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let app = app.clone();
    blocking(move |cancel| operation(&app.state::<AppState>().db, cancel)).await
}
