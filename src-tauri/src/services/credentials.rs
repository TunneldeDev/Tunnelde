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

async fn read_checked<T: Send + 'static>(
    budget: &Budget,
    check: impl Fn() -> AppResult<()> + Send + 'static,
    read: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    budget
        .blocking(move |job| {
            // Validate at actual admission, including time spent waiting for
            // the database. Cancellation may still win before OS access starts.
            check()?;
            job.commit()?;
            let value = read()?;
            // A read has no publication to roll back. Discard its value if
            // the original review changed while the OS operation was pending.
            check()?;
            Ok(value)
        })
        .await
}

/// Read-only acquisition: the caller owns the original review check. No DB
/// guard may span OS access, and the value stays private until revalidated.
pub(crate) async fn load_reviewed(
    app: AppHandle,
    host_id: String,
    check: impl Fn(&AppHandle) -> AppResult<()> + Send + 'static,
) -> AppResult<Option<String>> {
    let checked_app = app.clone();
    read_checked(
        &WORKERS,
        move || check(&checked_app),
        move || app.state::<AppState>().vault.load(&host_id),
    )
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

/// Read-only inspection may need several OS credential reads while assembling
/// a route. Share the same capacity and cancellation boundary as direct access.
pub(crate) async fn inspect<T: Send + 'static>(
    inspection: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    run(&WORKERS, inspection).await
}

/// A domain check can perform slow OS reads before its final synchronous
/// publication. Mutations must commit at that publication, so cancellation
/// while a read or DB check is pending cannot publish a late session/trust write.
pub(crate) async fn checked<T: Send + 'static>(
    operation: impl FnOnce(&crate::services::operations::Cancellation) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    WORKERS.blocking(operation).await
}

#[cfg(test)]
mod tests;
