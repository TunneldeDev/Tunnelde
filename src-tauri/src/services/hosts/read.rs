//! Native/plugin snapshot readers. Authorization never runs under the DB lock.
use super::{snapshot_connection, Snapshot};
use crate::{
    db::Database,
    error::AppResult,
    services::operations::{Budget, Errors},
};
use std::{sync::LazyLock, time::Duration};
use tauri::{AppHandle, Manager};

const ERRORS: Errors = Errors {
    domain: "hosts.read",
    busy: "hosts.read.busy",
    cancelled: "hosts.read.cancelled",
    failed: "hosts.read.unavailable",
};

pub(crate) async fn snapshot(
    app: &AppHandle,
    authorize: impl Fn() -> AppResult<()> + Send + 'static,
) -> AppResult<Snapshot> {
    static READERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
    // Retain application/storage ownership until the actual worker exits,
    // including when the transport has already abandoned its result.
    let app = app.clone();
    READERS
        .blocking(move |cancel| {
            let state = app.state::<crate::state::AppState>();
            capture(&state.db, || cancel.check(), authorize)
        })
        .await
}

fn capture(
    db: &Database,
    cancelled: impl Fn() -> AppResult<()>,
    authorize: impl Fn() -> AppResult<()>,
) -> AppResult<Snapshot> {
    loop {
        cancelled()?;
        authorize()?;
        // Only lock-free cancellation checks run inside the database guard.
        // Nest query failures so authorization is rechecked after DB release
        // for successful snapshots and failures alike.
        let attempt = db.try_with(|conn| Ok(snapshot_connection(conn, &cancelled)));
        match attempt {
            Ok(None) => std::thread::sleep(Duration::from_millis(4)),
            result => {
                cancelled()?;
                authorize()?;
                return result.and_then(|snapshot| snapshot.expect("reader admitted"));
            }
        }
    }
}

#[cfg(test)]
#[path = "read/tests.rs"]
mod tests;
