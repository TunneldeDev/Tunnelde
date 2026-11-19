//! Native credential commands keep synchronous OS access off the UI/runtime threads.
#[cfg(test)]
use crate::error::AppError;
use crate::error::AppResult;
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
        move || {
            let state = app.state::<AppState>();
            let authority = state
                .db
                .with(|conn| authority::HostAuthority::capture(conn, &host_id))?;
            let service = native::Service::new(&state.db, &state.vault, state.credentials.run)?;
            let request = service.capture(
                bindings::Owner::host(&host_id)?,
                || Ok(()),
                |conn| authority.check(conn),
            )?;
            service.read_after_admission(&request)
        },
    )
    .await
}

pub(crate) async fn status(app: AppHandle, host_id: String) -> AppResult<bool> {
    run(&WORKERS, move || {
        let state = app.state::<AppState>();
        let authority = state
            .db
            .with(|conn| authority::HostAuthority::capture(conn, &host_id))?;
        let service = native::Service::new(&state.db, &state.vault, state.credentials.run)?;
        let request = service.capture(
            bindings::Owner::host(&host_id)?,
            || Ok(()),
            |conn| authority.check(conn),
        )?;
        Ok(service.read_after_admission(&request)?.is_some())
    })
    .await
}

/// Composite route/HTTP/process workers already own their bounded admission.
/// Resolve the exact binding and reject any concurrent profile/incarnation edit.
pub(crate) fn read_proxy(
    state: &AppState,
    expected: &crate::network::ProxyProfile,
) -> AppResult<Option<String>> {
    let service = native::Service::new(&state.db, &state.vault, state.credentials.run)?;
    let request = service.capture(
        bindings::Owner::proxy(&expected.id)?,
        || Ok(()),
        |conn| authority::proxy_stamp(conn, expected),
    )?;
    service.read_after_admission(&request)
}

pub(crate) fn host_incarnation(
    conn: &rusqlite::Connection,
    id: &str,
) -> AppResult<Option<uuid::Uuid>> {
    lifecycle::host_incarnation(conn, id)
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

pub(crate) async fn mutate_reviewed(
    app: AppHandle,
    host_id: String,
    password: Option<String>,
    before: impl Fn(&AppHandle) -> AppResult<()> + Send + 'static,
    check: impl Fn(&rusqlite::Connection) -> AppResult<String> + Send + 'static,
) -> AppResult<()> {
    let result_app = app.clone();
    let result = checked(move |job| {
        if password.as_deref() == Some("") {
            return Err(crate::error::AppError::validation("ssh.passwordRequired"));
        }
        let state = app.state::<AppState>();
        let service = native::Service::new(&state.db, &state.vault, state.credentials.run)?;
        let request = service.capture(
            bindings::Owner::host(&host_id)?,
            || before(&app),
            |conn| {
                crate::db::hosts::find_host(conn, &host_id)?;
                Ok(native::Stamp::capture(check(conn)?.as_bytes()))
            },
        )?;
        match password {
            Some(value) => service.save(&request, &value, job),
            None => service.forget(&request, job),
        }
    })
    .await;
    schedule_cleanup(&result_app);
    result
}

#[cfg(test)]
mod tests;

// Native binding metadata and OS orchestration share one domain boundary.
mod bindings;
pub(crate) mod lifecycle;

mod native;

mod authority;
mod cleanup;
mod cleanup_wake;
pub(crate) use cleanup::{schedule as schedule_cleanup, Runtime};

pub(crate) mod editor;

pub(crate) mod transfer;
