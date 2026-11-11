//! Native provider bridge for forwarding; historical plugin RPCs stay independent.
mod access;
mod actions;
pub(crate) use actions::{remove, save, start, stop};
pub mod connection;
mod scope;
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
pub use scope::Registry;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Origin {
    pub token: String,
    pub scope: String,
}

#[tauri::command]
pub fn forwarding_provider_open(
    app: AppHandle,
    token: String,
    host_id: String,
    view_id: String,
) -> AppResult<String> {
    let state = app.state::<AppState>();
    app.state::<super::frontend::Registry>()
        .with_lease(&token, |lease| {
            state
                .plugins
                .security
                .with_authorized(lease, access::READ, || {
                    let settings = state.settings.read().unwrap_or_else(|e| e.into_inner());
                    if !settings
                        .ui_providers
                        .get("forwarding")
                        .is_some_and(|selected| {
                            selected.plugin_id == lease.id && selected.view_id == view_id
                        })
                        || host_id.starts_with(super::host_sources::PREFIX)
                    {
                        return Err(AppError::validation("plugin.forwarding.expired"));
                    }
                    crate::services::hosts::resolve(&app, &host_id)?;
                    app.state::<Registry>().open(
                        lease.clone(),
                        token.clone(),
                        host_id,
                        view_id,
                        state
                            .ui_provider_revision
                            .load(std::sync::atomic::Ordering::SeqCst),
                    )
                })
        })
}
fn cleanup(app: &AppHandle, sessions: Vec<String>) {
    for session in sessions {
        let _ = crate::ssh::disconnect(app, &session);
    }
}
#[tauri::command]
pub fn forwarding_provider_close(app: AppHandle, origin: Origin) {
    cleanup(
        &app,
        app.state::<Registry>().close(&origin.scope, &origin.token),
    );
}
pub(super) fn remove_token(app: &AppHandle, token: &str) {
    if let Some(registry) = app.try_state::<Registry>() {
        cleanup(app, registry.remove(|_, scope| scope.token == token));
    }
}
pub(super) fn remove_runtime(app: &AppHandle, owner: &str, generation: impl Fn(u64) -> bool) {
    if let Some(registry) = app.try_state::<Registry>() {
        cleanup(
            app,
            registry
                .remove(|_, scope| scope.lease.id == owner && generation(scope.lease.generation)),
        );
    }
}
pub(crate) fn retire_selections(app: &AppHandle) {
    let state = app.state::<AppState>();
    let revision = state
        .ui_provider_revision
        .load(std::sync::atomic::Ordering::SeqCst);
    if let Some(registry) = app.try_state::<Registry>() {
        cleanup(
            app,
            registry.remove(|_, scope| scope.selection_revision < revision),
        );
    }
}
pub(crate) fn clear(app: &AppHandle) {
    if let Some(registry) = app.try_state::<Registry>() {
        cleanup(app, registry.remove(|_, _| true));
    }
}
