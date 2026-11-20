//! Public metadata and plugin-owned empty-window lifetimes. This API never
//! exposes document tokens, staged capsules, read models or resource handles.
use super::{
    native,
    ownership::{Ownership, MAIN},
};
use crate::{
    error::{AppError, AppResult},
    plugins::security::Lease as PluginLease,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;

pub(crate) struct PublicWindows {
    state: Mutex<Metadata>,
    changed: watch::Sender<String>,
    created: Mutex<HashMap<String, PluginLease>>,
}
struct Metadata {
    projection: Value,
    revision: String,
}
impl Default for PublicWindows {
    fn default() -> Self {
        Self {
            state: Mutex::new(Metadata {
                projection: Value::Null,
                revision: String::new(),
            }),
            changed: watch::channel(String::new()).0,
            created: Mutex::new(HashMap::new()),
        }
    }
}
impl PublicWindows {
    fn update(&self, projection: Value) -> (Value, Option<String>) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let changed = if state.projection != projection {
            state.projection = projection;
            state.revision = uuid::Uuid::new_v4().to_string();
            self.changed.send_replace(state.revision.clone());
            Some(state.revision.clone())
        } else {
            None
        };
        let mut value = state.projection.clone();
        value["revision"] = json!(state.revision);
        (value, changed)
    }
    fn retire(&self, owner: &str, before: u64) -> Vec<String> {
        let mut created = self
            .created
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut retired = Vec::new();
        created.retain(|id, lease| {
            if lease.id == owner && lease.generation < before {
                retired.push(id.clone());
                false
            } else {
                true
            }
        });
        retired
    }
    pub(super) fn forget(&self, window: &str) {
        self.created
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(window);
    }
}

impl Ownership {
    /// Closed display projection. A generation is a stale-owner marker, not a
    /// bearer credential; native commands still derive their caller/document.
    fn public_metadata(&self) -> Value {
        let owners = self.leases();
        let windows: Vec<_> = self.windows().into_iter().map(|window| {
            let panels: Vec<_> = owners.iter().filter(|lease| lease.window_id == window.id).map(|lease| &lease.panel_id).collect();
            json!({"id": window.id, "role": if window.id == MAIN { "coordinator" } else { "satellite" }, "ready": window.ready, "closing": window.closing, "panelIds": panels})
        }).collect();
        let panels: Vec<_> = owners.iter().map(|lease| {
            let transferable = super::ownership::transferable(&lease.panel_id);
            let can_move = transferable && self.document(&lease.window_id).is_some_and(|document| self.authorize_creation(&lease.window_id, document, Some(lease)).is_ok());
            json!({"panelId": lease.panel_id, "windowId": lease.window_id, "generation": lease.generation, "transferable": transferable, "canMove": can_move})
        }).collect();
        json!({"windowId": MAIN, "windows": windows, "panels": panels})
    }
    fn public_close_target(&self, window: &str) -> Result<(), &'static str> {
        if window == MAIN {
            return Err("coordinator cannot close");
        }
        if !self
            .windows()
            .iter()
            .any(|target| target.id == window && target.ready && !target.closing)
        {
            return Err("window not ready");
        }
        // Native request_close follows the normal source-side capture/return
        // protocol. Never force-destroy or cancel another in-flight handoff.
        if self
            .leases()
            .iter()
            .filter(|lease| lease.window_id == window)
            .any(|lease| {
                self.document(window).is_none_or(|document| {
                    self.authorize_creation(window, document, Some(lease))
                        .is_err()
                })
            })
        {
            return Err("panel interaction in progress");
        }
        if self
            .offers(MAIN, self.document(MAIN).ok_or("coordinator unavailable")?)?
            .iter()
            .any(|pending| {
                pending.offer.target_window == window || pending.offer.lease.window_id == window
            })
        {
            return Err("panel is frozen");
        }
        Ok(())
    }
}

pub(crate) fn snapshot(app: &AppHandle) -> Value {
    let registry = app.state::<native::Registry>();
    let ownership = native::lock(&registry);
    // Keep lock order ownership -> public; otherwise concurrent invalidations
    // can publish an older projection after a newer ownership transaction.
    let (snapshot, changed) = registry.public.update(ownership.public_metadata());
    drop(ownership);
    if let Some(revision) = changed {
        let _ = app.emit("workspace://windows-changed", json!({"revision": revision}));
    }
    snapshot
}

pub(crate) async fn observe(app: &AppHandle, revision: Option<String>) -> Value {
    let registry = app.state::<native::Registry>();
    let mut changes = registry.public.changed.subscribe();
    let current = snapshot(app);
    if current["revision"].as_str() != revision.as_deref() {
        return current;
    }
    // Subscription precedes inspection. Native teardown/reload and long-poll
    // cancellation drop the receiver; no detached per-plugin polling worker.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), changes.changed()).await;
    snapshot(app)
}

fn authorized(app: &AppHandle, owner: &PluginLease) -> AppResult<()> {
    app.state::<crate::state::AppState>()
        .plugins
        .security
        .authorize(
            &owner.id,
            &owner.fingerprint,
            &owner.permissions,
            Some("workspace.write"),
            Some(owner.generation),
        )
        .map(|_| ())
}

#[derive(Default)]
struct CreationLifetime {
    cancelled: bool,
    id: Option<String>,
}
impl CreationLifetime {
    fn admit(&mut self, id: &str) -> bool {
        if self.cancelled {
            return false;
        }
        self.id = Some(id.into());
        true
    }
    fn cancel(&mut self) -> Option<String> {
        self.cancelled = true;
        self.id.take()
    }
}
struct CreationWait {
    app: AppHandle,
    lifetime: Arc<Mutex<CreationLifetime>>,
    accepted: bool,
}
impl Drop for CreationWait {
    fn drop(&mut self) {
        if self.accepted {
            return;
        }
        let id = self
            .lifetime
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .cancel();
        if let Some(id) = id {
            super::lifecycle::discard_empty(&self.app, &id);
        }
    }
}

/// Native WebView construction is not cancel-safe. Retain its worker to actual
/// settlement even if a plugin request is cancelled; clean late empty windows.
/// This does not create a second plugin/bootstrap/resource coordinator.
pub(crate) async fn create(app: &AppHandle, owner: PluginLease) -> AppResult<Value> {
    authorized(app, &owner)?;
    let main = app
        .get_webview_window(MAIN)
        .ok_or_else(|| AppError::validation("coordinator unavailable"))?;
    let document = native::lock(&app.state::<native::Registry>())
        .document(MAIN)
        .ok_or_else(|| AppError::validation("coordinator unavailable"))?
        .to_owned();
    let lifetime = Arc::new(Mutex::new(CreationLifetime::default()));
    let mut wait = CreationWait {
        app: app.clone(),
        lifetime: lifetime.clone(),
        accepted: false,
    };
    let app = app.clone();
    let (reply, receiver) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        if reply.is_closed() {
            return;
        }
        let result = native::panel_window_create(app.clone(), main, document, None).await;
        match result {
            Ok(id) => {
                // Cancellation may occur before allocation, during native
                // construction, after send, or before the receiver consumes it.
                let admitted = {
                    let mut lifetime = lifetime.lock().unwrap_or_else(|error| error.into_inner());
                    if lifetime.admit(&id) {
                        // Publish creator ownership before a cancelled receiver
                        // can take/remove the ID and trigger native teardown.
                        app.state::<native::Registry>()
                            .public
                            .created
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .insert(id.clone(), owner.clone());
                        true
                    } else {
                        false
                    }
                };
                if !admitted {
                    super::lifecycle::discard_empty(&app, &id);
                    return;
                }
                if let Err(error) = authorized(&app, &owner) {
                    super::lifecycle::discard_empty(&app, &id);
                    let _ = reply.send(Err(error));
                    return;
                }
                let result = snapshot(&app)["windows"]
                    .as_array()
                    .and_then(|windows| windows.iter().find(|window| window["id"] == id))
                    .cloned()
                    .ok_or_else(|| AppError::validation("window not ready"));
                if reply.send(result).is_err() {
                    super::lifecycle::discard_empty(&app, &id);
                }
            }
            Err(error) => {
                let _ = reply.send(Err(error));
            }
        }
    });
    let result = receiver
        .await
        .map_err(|_| AppError::validation("window creation failed"))?;
    if result.is_ok() {
        wait.accepted = true;
    }
    result
}

pub(crate) fn close(app: &AppHandle, id: &str) -> AppResult<Value> {
    let registry = app.state::<native::Registry>();
    native::lock(&registry)
        .public_close_target(id)
        .map_err(native::invalid)?;
    let target = app
        .get_webview_window(id)
        .ok_or_else(|| AppError::validation("invalid window"))?;
    target.close()?; // Emits normal CloseRequested; source retains capture/guards.
    Ok(json!({"windowId": id, "requested": true}))
}

pub(crate) fn retire(app: &AppHandle, owner: &str, before: u64) {
    if let Some(registry) = app.try_state::<native::Registry>() {
        super::plugin_views::gateway::retire(app, owner, before);
        for id in registry.public.retire(owner, before) {
            super::lifecycle::discard_empty(app, &id);
        }
    }
}

#[cfg(test)]
mod tests;

pub(crate) async fn move_panel(
    app: &AppHandle,
    owner: PluginLease,
    request: super::public_moves::MoveRequest,
) -> AppResult<Value> {
    super::public_moves::request(app, owner, request).await
}
