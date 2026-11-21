//! Headless equivalents of native host migration; no file picker or connection.
use super::*;
use crate::{services::hosts::transfer, state::AppState};
use tauri::Manager;
const READ: &[&str] = &[
    "hosts.read",
    "forwards.read",
    "mounts.read",
    "settings.read",
];
const WRITE: &[&str] = &[
    "hosts.read",
    "hosts.write",
    "forwards.write",
    "mounts.write",
    "settings.write",
];
pub(super) async fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let state = context.app.state::<AppState>();
    let lease = super::lease(context);
    if method == "hosts.transfer.apply" {
        let request: transfer::ImportRequest = field(&params, "request")?;
        let origin = crate::platform::panel_windows::plugin_views::origin::current();
        // Cancellation/revocation while queued must not become a late import.
        let _commit = state
            .plugins
            .security
            .guard(&lease, async { Ok(state.settings_commit.lock().await) })
            .await?;
        return state.plugins.security.with_authorized_fenced_database_then(
            &state.db,
            &lease,
            WRITE,
            || Ok(()),
            origin
                .as_ref()
                .map(|origin| origin as &dyn crate::services::operations::Authority),
            |conn| transfer::apply_at(conn, request),
            |imported| {
                transfer::files::publish(&context.app, &state, &imported)?;
                encode(imported)
            },
        );
    }
    state.plugins.security.with_authorized(&lease, READ, || {
        state.db.with(|conn| match method {
            "hosts.transfer.export" => encode(transfer::export_at(
                conn,
                &field::<Vec<String>>(&params, "ids")?,
            )?),
            "hosts.transfer.preview" => {
                encode(transfer::preview_at(conn, field(&params, "document")?)?)
            }
            _ => Err(AppError::validation("plugin.api.unknownMethod")),
        })
    })
}
