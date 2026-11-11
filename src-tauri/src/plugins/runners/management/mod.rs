//! Host-owned recovery remains available without executing a plugin runtime.
mod actions;
pub(crate) mod browser;
mod contracts;
mod mutation;
mod projection;
mod query;
use crate::{error::AppResult, state::AppState};
pub use contracts::{Outcome, Owners, Request, Snapshot};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn runner_recovery_owners(app: AppHandle) -> AppResult<Owners> {
    query::owners(
        app.state::<AppState>()
            .storage
            .dir(crate::storage::layout::Category::Runners),
    )
}
#[tauri::command]
pub async fn runner_recovery_snapshot(
    app: AppHandle,
    plugin_id: String,
    offset: usize,
) -> AppResult<Snapshot> {
    query::snapshot(&app, &plugin_id, offset)
        .await
        .inspect_err(|error| {
            tracing::warn!(plugin_id, %error, "could not read remote task recovery page");
        })
}
#[tauri::command]
pub async fn runner_recovery_action(app: AppHandle, request: Request) -> AppResult<Outcome> {
    let plugin_id = request.plugin_id.clone();
    actions::execute(&app, request).await.inspect_err(|error| {
        tracing::warn!(plugin_id, %error, "remote task recovery action failed");
    })
}

#[cfg(test)]
mod tests;
