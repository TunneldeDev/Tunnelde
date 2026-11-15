//! Native credential commands keep synchronous OS access off the UI/runtime threads.
use crate::db;
use crate::error::{AppError, AppResult};
use crate::services::operations::{Budget, Errors};
use crate::state::AppState;
use std::sync::LazyLock;
use tauri::{AppHandle, Manager};

// Include the target and the maximum eight jump-host status requests without
// allowing repeated UI requests to enqueue unbounded platform operations.
static WORKERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(16, ERRORS));
const ERRORS: Errors = Errors {
    domain: "credentials",
    busy: "credentials.busy",
    cancelled: "credentials.cancelled",
    failed: "credentials.workerFailed",
};

async fn run<T: Send + 'static>(
    budget: &Budget,
    operation: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    budget
        .blocking(move |job| {
            // Cancellation before worker admission must not start a late write.
            // Once admitted, OS access settles even if reply delivery is lost.
            job.commit()?;
            operation()
        })
        .await
}

pub(crate) async fn save(app: AppHandle, host_id: String, password: String) -> AppResult<()> {
    run(&WORKERS, move || {
        if password.is_empty() {
            return Err(AppError::validation("ssh.passwordRequired"));
        }
        let state = app.state::<AppState>();
        state.db.with(|conn| db::hosts::find_host(conn, &host_id))?;
        state.vault.save(&host_id, &password)
    })
    .await
}

pub(crate) async fn forget(app: AppHandle, host_id: String) -> AppResult<()> {
    run(&WORKERS, move || {
        app.state::<AppState>().vault.forget(&host_id)
    })
    .await
}

pub(crate) async fn status(app: AppHandle, host_id: String) -> AppResult<bool> {
    run(&WORKERS, move || {
        app.state::<AppState>().vault.has(&host_id)
    })
    .await
}

pub(crate) async fn proxy_password(
    app: AppHandle,
    id: String,
    password: Option<String>,
) -> AppResult<()> {
    run(&WORKERS, move || {
        let state = app.state::<AppState>();
        if !state.settings().network.profiles.iter().any(|p| p.id == id) {
            return Err(AppError::validation("network.proxyMissing"));
        }
        let key = format!("proxy:{id}");
        match password {
            Some(value) if value.len() <= 4096 => state.vault.save(&key, &value),
            None => state.vault.forget(&key),
            _ => Err(AppError::validation("network.invalid")),
        }
    })
    .await
}

#[cfg(test)]
mod tests;
