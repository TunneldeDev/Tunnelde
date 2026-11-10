//! Window effects, persistence rollback and ordered committed notifications.
use super::mutation::Kind;
use crate::{error::AppResult, settings::Settings};
use tauri::{AppHandle, Emitter};

pub(super) fn stage(
    app: &AppHandle,
    previous: &Settings,
    next: &Settings,
    kind: Kind,
) -> AppResult<bool> {
    let title_changed =
        matches!(kind, Kind::Preferences) && previous.title_bar_style != next.title_bar_style;
    if title_changed {
        crate::platform::window::apply_title_bar_style(app, &next.title_bar_style)?;
    }
    Ok(title_changed)
}

pub(super) fn rollback_title(app: &AppHandle, previous: &Settings) {
    if let Err(rollback) =
        crate::platform::window::apply_title_bar_style(app, &previous.title_bar_style)
    {
        tracing::warn!(%rollback, "could not restore title bar after settings persistence failed");
    }
}

pub(super) fn publish(app: &AppHandle, previous: &Settings, next: &Settings, kind: Kind) {
    if matches!(kind, Kind::Preferences) {
        for profile in &previous.network.profiles {
            if !next
                .network
                .profiles
                .iter()
                .any(|item| item.id == profile.id)
            {
                if let Err(error) = crate::vault::forget(&format!("proxy:{}", profile.id)) {
                    tracing::warn!(%error, "could not remove deleted proxy credential");
                }
            }
        }
        crate::plugins::forwarding::retire_selections(app);
        crate::platform::window::apply_theme(app, &next.theme);
        crate::platform::window::apply_background_dock_preference(app);
    }
    // Metadata commits also publish the confirmed snapshot. This prevents a later
    // frontend save from displaying an obsolete update-check timestamp.
    let _ = app.emit("settings://changed", next);
}
