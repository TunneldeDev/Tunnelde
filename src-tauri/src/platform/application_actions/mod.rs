//! Native tray intents use the current document's confirmation and final
//! checkpoint. No slow UI work or database lock belongs in a native menu callback.
mod queue;
#[cfg(test)]
mod tests;

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Action {
    Restart,
    Quit,
}

#[derive(Default)]
pub(crate) struct Registry(Mutex<queue::Queue>);

pub(crate) fn request(app: &AppHandle, action: Action) {
    app.state::<Registry>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .submit(action);
    super::window::show_main(app);
    deliver(app);
}

pub(crate) fn deliver(app: &AppHandle) {
    if !super::window::is_ready(app) || super::background::keep_alive(app) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let state = app.state::<Registry>();
    let request = state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take_delivery();
    if let Some(request) = request {
        if let Err(error) = window.emit("ui://application-action", &request) {
            state
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .delivery_failed(&request);
            tracing::warn!(%error, "could not deliver native application action; retained without exiting");
        }
    }
}

pub(crate) fn reset(app: &AppHandle) {
    app.state::<Registry>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .reset();
}

fn main_window(window: &WebviewWindow) -> AppResult<()> {
    if window.label() != "main" {
        return Err(AppError::validation("invalid window"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn application_action_claim(window: WebviewWindow, owner: String) -> AppResult<()> {
    main_window(&window)?;
    if uuid::Uuid::parse_str(&owner)
        .ok()
        .is_none_or(|id| id.to_string() != owner)
    {
        return Err(AppError::validation("invalid window document"));
    }
    window
        .state::<Registry>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .claim(owner);
    deliver(window.app_handle());
    Ok(())
}

#[tauri::command]
pub(crate) fn application_action_release(window: WebviewWindow, owner: String) -> AppResult<()> {
    main_window(&window)?;
    window
        .state::<Registry>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .release(&owner);
    Ok(())
}

#[tauri::command]
pub(crate) fn application_action_finish(
    window: WebviewWindow,
    owner: String,
    id: String,
) -> AppResult<()> {
    main_window(&window)?;
    let state = window.state::<Registry>();
    let action = state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .begin(&owner, &id)?;
    // Commit admission is above; neither the queue lock nor a document guard is
    // retained while shutdown/restart runs.
    let result = match action {
        Action::Quit => {
            window.app_handle().exit(0);
            Ok(())
        }
        Action::Restart => super::restart::restart(window.app_handle()),
    };
    if result.is_err() {
        state
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .failed(&id);
    }
    result
}
