//! Reserve before invoking: cancellation may overtake an IPC dispatch, but can
//! never overtake reservation and accidentally allow the cancelled work to start.
use super::{authorized, Registry};
use crate::{error::AppResult, state::AppState};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub fn plugin_frontend_prepare_call(
    app: AppHandle,
    registry: State<'_, Registry>,
    token: String,
) -> AppResult<String> {
    registry.with_lease(&token, |lease| {
        authorized(&app.state::<AppState>().plugins.security, lease)?;
        let id = uuid::Uuid::new_v4().to_string();
        registry.calls.reserve(&token, &id)?;
        Ok(id)
    })
}

#[tauri::command]
pub fn plugin_frontend_cancel_call(
    registry: State<'_, Registry>,
    token: String,
    request_id: String,
) -> bool {
    // An expired owner must still be able to release its own reservation.
    registry.calls.cancel(&token, &request_id)
}
