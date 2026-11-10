//! Native IPC adapter for the forwarding domain. Keep command names and wire DTOs compatible.
use crate::{
    error::AppResult,
    services::forwarding::{
        self,
        contract::{ForwardInfo, ForwardRule},
    },
};
use tauri::AppHandle;

#[tauri::command]
pub fn forwarding_list(app: AppHandle) -> AppResult<Vec<ForwardInfo>> {
    forwarding::list(&app)
}
#[tauri::command]
pub fn forwarding_save(app: AppHandle, rule: ForwardRule) -> AppResult<ForwardRule> {
    forwarding::save(&app, rule)
}
#[tauri::command]
pub fn forwarding_remove(app: AppHandle, id: String) -> AppResult<()> {
    forwarding::remove(&app, &id)
}
#[tauri::command]
pub async fn forwarding_start(app: AppHandle, id: String, session_id: String) -> AppResult<()> {
    forwarding::start_owned(&app, &id, &session_id, None).await
}
#[tauri::command]
pub async fn forwarding_stop(app: AppHandle, id: String) -> AppResult<()> {
    forwarding::stop(&app, &id).await
}
