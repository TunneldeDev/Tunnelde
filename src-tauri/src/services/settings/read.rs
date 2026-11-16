//! Bounded public reads retain serialization until the actual worker exits.
use super::preferences::{contracts, observation, projection};
use crate::services::operations::{Budget, Errors};
use crate::{db::Database, error::AppResult, settings::Settings};
use std::sync::LazyLock;
use tauri::{AppHandle, Manager};

const ERRORS: Errors = Errors {
    domain: "preferences.read",
    busy: "preferences.read.busy",
    cancelled: "preferences.read.cancelled",
    failed: "preferences.read.unavailable",
};

pub(crate) async fn snapshot(
    app: &AppHandle,
    check: impl Fn() -> AppResult<()> + Send + 'static,
) -> AppResult<contracts::Snapshot> {
    read(app, check, projection::snapshot).await
}

pub(crate) async fn observe(
    app: &AppHandle,
    request: contracts::Observe,
    check: impl Fn() -> AppResult<()> + Send + 'static,
) -> AppResult<contracts::Observation> {
    read(app, check, move |current, revision| {
        observation::project(current, revision, request)
    })
    .await
}

async fn read<T: Send + 'static>(
    app: &AppHandle,
    check: impl Fn() -> AppResult<()> + Send + 'static,
    project: impl FnOnce(&Settings, String) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    static READERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
    let app = app.clone();
    READERS
        .blocking(move |cancellation| {
            let state = app.state::<crate::state::AppState>();
            ordered(
                &state.db,
                &state.settings_commit,
                || state.settings(),
                || cancellation.check(),
                &check,
                project,
            )
        })
        .await
}

// Called only on a blocking worker. Keep the same serialization used by native,
// plugin and Profile mutations, including their post-commit publication.
fn ordered<T>(
    db: &Database,
    serial: &tokio::sync::Mutex<()>,
    current: impl FnOnce() -> Settings,
    cancelled: impl Fn() -> AppResult<()>,
    authorize: impl Fn() -> AppResult<()>,
    project: impl FnOnce(&Settings, String) -> AppResult<T>,
) -> AppResult<T> {
    cancelled()?;
    authorize()?;
    let _serial = serial.blocking_lock();
    cancelled()?;
    authorize()?;
    let current = current();
    // Do not acquire the plugin policy lock under the DB lock: mutation
    // admission may hold policy while persisting. Only cancellation is lock-free.
    let revision = revision(db, &current, &cancelled)?;
    cancelled()?;
    authorize()?;
    let result = project(&current, revision)?;
    cancelled()?;
    authorize()?;
    Ok(result)
}

pub(super) fn revision(
    db: &Database,
    current: &Settings,
    check: impl Fn() -> AppResult<()>,
) -> AppResult<String> {
    db.with(|conn| {
        check()?;
        super::repository::revision(conn, current)
    })
}

#[cfg(test)]
#[path = "read/tests.rs"]
mod tests;
