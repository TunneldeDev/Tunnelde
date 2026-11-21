//! Empty placeholders are presentation resources only. Creator cancellation,
//! revocation and platform errors must use the same atomic emptiness gate.
use super::native::{self, Registry};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// False means occupied, transferring, already gone, or platform failure. It is
/// never a reason to force-destroy: a later reaper can retry an empty window.
pub(super) fn discard_empty(app: &AppHandle, id: &str) -> bool {
    let registry = app.state::<Registry>();
    // Reserve while holding ownership before any asynchronous native callback.
    // Incoming handoffs cannot land between this check and native destruction.
    if native::lock(&registry).reserve_empty_close(id).is_err() {
        return false;
    }
    if let Some(window) = app.get_webview_window(id) {
        if window.destroy().is_err() {
            native::lock(&registry).release_empty_close(id);
            native::changed(app);
            return false;
        }
    }
    let _ = native::lock(&registry).destroyed(id);
    registry.public.forget(id);
    registry
        .creations
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(id);
    native::changed(app);
    true
}

pub(super) fn reap_empty_later(app: &AppHandle, id: &str) {
    let app = app.clone();
    let id = id.to_owned();
    tauri::async_runtime::spawn(async move {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let registry = app.state::<Registry>();
            let gone_or_owned = {
                let ownership = native::lock(&registry);
                ownership.document(&id).is_none()
                    || ownership.leases().iter().any(|lease| lease.window_id == id)
            };
            if gone_or_owned {
                registry
                    .creations
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&id);
                break;
            }
            // Active handoffs survive the deadline; retry once they settle.
            if Instant::now() >= deadline && discard_empty(&app, &id) {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::super::ownership::Ownership;
    use serde_json::Value;
    use std::time::Instant;

    #[test]
    fn creator_loss_never_grants_empty_cleanup_over_a_destination_handoff_or_user_panel() {
        let mut state = Ownership::default();
        let creator = state.register("main").unwrap();
        state.ready("main", &creator).unwrap();
        let target = state.register("target").unwrap();
        state.ready("target", &target).unwrap();
        let panel = state.add_panel("main", &creator, "tasks").unwrap();
        // Native construction can settle after its source reload. A new main
        // document may already be preparing a user panel for that destination.
        let current = state.register("main").unwrap();
        state.ready("main", &current).unwrap();
        assert!(state.authorize_creation("main", &creator, None).is_err());
        let panel = state
            .leases()
            .into_iter()
            .find(|lease| lease.panel_id == panel.panel_id)
            .unwrap();
        let now = Instant::now();
        let transfer = state
            .prepare("main", &current, &panel, "target", Value::Null, now)
            .unwrap();
        assert!(state.reserve_empty_close("target").is_err());
        state
            .acknowledge("target", &target, &transfer.id, now)
            .unwrap();
        let moved = state.commit("main", &current, &transfer.id, now).unwrap();
        assert!(state.reserve_empty_close("target").is_err());
        assert!(state.view("target", &target, &moved).is_ok());
        // Only after the panel returns may an abandoned placeholder be reaped.
        let returning = state
            .prepare("target", &target, &moved, "main", Value::Null, now)
            .unwrap();
        state
            .acknowledge("main", &current, &returning.id, now)
            .unwrap();
        state.commit("main", &current, &returning.id, now).unwrap();
        assert!(state.reserve_empty_close("target").is_ok());
    }
}
