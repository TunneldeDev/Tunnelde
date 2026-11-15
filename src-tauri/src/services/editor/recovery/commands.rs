use super::{
    contracts::{Draft, Snapshot},
    repository,
};
use crate::{
    error::AppResult,
    services::operations::{Budget, Errors},
    state::AppState,
};
use std::sync::LazyLock;
use tauri::{AppHandle, Manager};

static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
    Budget::new(
        2,
        Errors {
            domain: "editor.recovery",
            busy: "editor.recoveryBusy",
            cancelled: "editor.recoveryCancelled",
            failed: "editor.recoveryFailed",
        },
    )
});

#[tauri::command]
pub(crate) async fn editor_drafts_read(app: AppHandle) -> AppResult<Snapshot> {
    WORKERS
        .blocking(move |_| app.state::<AppState>().db.with(repository::read))
        .await
}

#[tauri::command]
pub(crate) async fn editor_drafts_save(
    app: AppHandle,
    revision: String,
    drafts: Vec<Draft>,
) -> AppResult<String> {
    WORKERS
        .blocking(move |cancellation| {
            let state = app.state::<AppState>();
            state.db.with(|conn| {
                cancellation.commit()?;
                repository::save(conn, &revision, drafts)
            })
        })
        .await
}
