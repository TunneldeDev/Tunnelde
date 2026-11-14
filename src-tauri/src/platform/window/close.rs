//! Native close authority belongs to the current document, not a JavaScript
//! close listener which Tauri retains after a raw WebView navigation.
use crate::error::{AppError, AppResult};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[derive(Default)]
struct Document {
    owner: Option<String>,
    approved: bool,
}
impl Document {
    fn claim(&mut self, owner: String) {
        self.owner = Some(owner);
        self.approved = false;
    }
    fn release(&mut self, owner: &str) {
        if self.owner.as_deref() == Some(owner) {
            *self = Self::default();
        }
    }
    fn approve(&mut self, owner: &str) -> AppResult<()> {
        if self.owner.as_deref() != Some(owner) {
            return Err(AppError::validation("invalid window document"));
        }
        self.approved = true;
        Ok(())
    }
    fn intercept(&mut self, keep_alive: bool) -> Option<String> {
        let approved = std::mem::take(&mut self.approved);
        if keep_alive || approved {
            None
        } else {
            self.owner.clone()
        }
    }
}
#[derive(Default)]
pub(crate) struct Registry(Mutex<Document>);

fn main_window(window: &WebviewWindow) -> AppResult<()> {
    if window.label() != "main" {
        return Err(AppError::validation("invalid window"));
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn main_window_close_guard_claim(window: WebviewWindow, owner: String) -> AppResult<()> {
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
        .unwrap_or_else(|error| error.into_inner())
        .claim(owner);
    Ok(())
}
#[tauri::command]
pub(crate) fn main_window_close_guard_release(
    window: WebviewWindow,
    owner: String,
) -> AppResult<()> {
    main_window(&window)?;
    window
        .state::<Registry>()
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .release(&owner);
    Ok(())
}
#[tauri::command]
pub(crate) fn main_window_close_guard_finish(
    window: WebviewWindow,
    owner: String,
) -> AppResult<()> {
    main_window(&window)?;
    window
        .state::<Registry>()
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .approve(&owner)?;
    if let Err(error) = window.close() {
        let state = window.state::<Registry>();
        let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
        if guard.owner.as_deref() == Some(&owner) {
            guard.approved = false;
        }
        return Err(error.into());
    }
    Ok(())
}
pub(crate) fn reset(app: &AppHandle) {
    *app.state::<Registry>()
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Document::default();
}
pub(super) fn intercept(app: &AppHandle, keep_alive: bool) -> bool {
    let owner = app
        .state::<Registry>()
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .intercept(keep_alive);
    if let Some(owner) = owner {
        if let Some(window) = app.get_webview_window("main") {
            if let Err(error) = window.emit("ui://close-requested", owner) {
                tracing::warn!(%error, "Could not request document close review");
            }
        }
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approval_is_single_use_and_stale_documents_cannot_close_or_release_a_successor() {
        let mut doc = Document::default();
        assert!(doc.intercept(false).is_none());
        doc.claim("first".into());
        assert_eq!(doc.intercept(false).as_deref(), Some("first"));
        doc.approve("first").unwrap();
        assert!(doc.intercept(false).is_none());
        assert_eq!(doc.intercept(false).as_deref(), Some("first"));
        doc.approve("first").unwrap();
        assert!(doc.intercept(true).is_none());
        assert_eq!(doc.intercept(false).as_deref(), Some("first"));
        doc.approve("first").unwrap();
        doc.claim("next".into());
        assert!(doc.approve("first").is_err());
        doc.release("first");
        assert_eq!(doc.intercept(false).as_deref(), Some("next"));
        doc.release("next");
        assert!(doc.intercept(false).is_none());
    }
}
