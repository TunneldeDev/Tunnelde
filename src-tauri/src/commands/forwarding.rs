//! Native IPC adapter for the forwarding domain. Keep command names and wire DTOs compatible.
use crate::{
    error::AppResult,
    services::forwarding::{
        self,
        contract::{ForwardRule, RevisionedInfo, RevisionedRule},
    },
};
use tauri::AppHandle;

#[tauri::command]
pub fn forwarding_list(app: AppHandle) -> AppResult<Vec<RevisionedInfo>> {
    forwarding::list_revisioned(&app)
}
#[tauri::command]
pub fn forwarding_save(
    app: AppHandle,
    rule: ForwardRule,
    expected_revision: Option<String>,
) -> AppResult<RevisionedRule> {
    forwarding::save_checked(&app, rule, expected_revision.as_deref())
}
#[tauri::command]
pub fn forwarding_remove(
    app: AppHandle,
    id: String,
    expected_revision: Option<String>,
) -> AppResult<()> {
    forwarding::remove_checked(&app, &id, expected_revision.as_deref())
}
#[tauri::command]
pub async fn forwarding_start(
    app: AppHandle,
    id: String,
    session_id: String,
    expected_revision: Option<String>,
) -> AppResult<()> {
    forwarding::start_checked(&app, &id, &session_id, None, expected_revision.as_deref()).await
}
#[tauri::command]
pub async fn forwarding_stop(app: AppHandle, id: String) -> AppResult<()> {
    forwarding::stop(&app, &id).await
}
