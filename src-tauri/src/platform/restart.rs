use tauri::{AppHandle, Manager};

use crate::{error::AppResult, state::AppState};

pub fn restart(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    state.plugins.security.with_planned_restart(&state.db, || {
        app.restart();
    })
}

#[tauri::command]
pub fn app_restart(app: AppHandle) -> AppResult<()> {
    restart(&app)
}
