//! Public panel metadata and source-window presentation routing. No main-store
//! proxy for satellite UI, and no raw application IPC in a satellite.
use super::{
    native,
    ownership::Ownership,
    presentation::{LayoutMetadata, Presentation},
    presentation_jobs::PresentationOperation,
};
use crate::{
    error::{AppError, AppResult},
    plugins::security::Lease as PluginLease,
};
use serde_json::{json, Value};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;
pub(crate) struct PublicPanels {
    state: Mutex<State>,
    changed: watch::Sender<String>,
}
struct State {
    projection: Option<Value>,
    revision: String,
}
impl Default for PublicPanels {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                projection: None,
                revision: String::new(),
            }),
            changed: watch::channel(String::new()).0,
        }
    }
}
impl PublicPanels {
    fn update(&self, projection: Option<Value>) -> (Option<Value>, Option<String>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let changed = if state.projection != projection {
            state.projection = projection;
            state.revision = uuid::Uuid::new_v4().to_string();
            self.changed.send_replace(state.revision.clone());
            Some(state.revision.clone())
        } else {
            None
        };
        let value = state.projection.clone().map(|mut v| {
            v["revision"] = json!(state.revision);
            v
        });
        (value, changed)
    }
}
pub(crate) fn refresh(app: &AppHandle) -> Option<Value> {
    let registry = app.state::<native::Registry>();
    let ownership = native::lock(&registry);
    let (value, changed) = registry
        .public_panels
        .update(ownership.presentation_projection());
    drop(ownership);
    if let Some(revision) = changed {
        let _ = app.emit("workspace://panels-changed", json!({"revision":revision}));
    }
    value
}
pub(crate) async fn snapshot(
    app: &AppHandle,
    revision: Option<String>,
    observe: bool,
) -> AppResult<Value> {
    let registry = app.state::<native::Registry>();
    let mut changes = registry.public_panels.changed.subscribe();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(if observe { 10 } else { 2 });
    loop {
        let current = refresh(app);
        if let Some(ref value) = current {
            if !observe || value["revision"].as_str() != revision.as_deref() {
                return Ok(value.clone());
            }
        }
        if tokio::time::timeout_at(deadline, changes.changed())
            .await
            .is_err()
        {
            return current.ok_or_else(|| native::invalid("panel.window.viewNotReady"));
        }
    }
}
struct Wait {
    app: AppHandle,
    id: String,
}
impl Drop for Wait {
    fn drop(&mut self) {
        if native::lock(&self.app.state::<native::Registry>()).cancel_presentation(&self.id) {
            native::changed(&self.app);
        }
    }
}
pub(crate) async fn request(
    app: &AppHandle,
    owner: PluginLease,
    panel: String,
    presentation: Option<Presentation>,
) -> AppResult<Value> {
    if !super::ownership::valid_panel_id(&panel) {
        return Err(AppError::validation("plugin.api.invalid:panelId"));
    }
    let operation = presentation.map_or(PresentationOperation::Close, |presentation| {
        PresentationOperation::Set { presentation }
    });
    let (id, reply) = native::lock(&app.state::<native::Registry>())
        .submit_presentation(owner, &panel, operation, Instant::now())
        .map_err(native::invalid)?;
    let _wait = Wait {
        app: app.clone(),
        id,
    };
    native::changed(app);
    tokio::time::timeout(Duration::from_secs(20), reply)
        .await
        .map_err(|_| native::invalid("panel.window.timeout"))?
        .map_err(|_| native::invalid("panel.window.cancelled"))?
        .map_err(native::invalid)
}
/// The caller already holds native ownership. Policy/cancellation remain locked
/// through admission only; source completion is cleanup of an accepted UI effect.
pub(super) fn begin(
    app: &AppHandle,
    ownership: &mut Ownership,
    window: &str,
    document: &str,
    id: &str,
    now: Instant,
) -> AppResult<Value> {
    ownership
        .require_presentation_source(window, document, id)
        .map_err(native::invalid)?;
    let result = (|| {
        let (owner, invocation) = ownership
            .presentation_admission(window, document, id, now)
            .map_err(native::invalid)?;
        app.state::<crate::state::AppState>()
            .plugins
            .security
            .with_authorized(&owner, &["workspace.write"], || {
                let mut admit = || {
                    ownership.admit_presentation(id);
                    Ok(Value::Null)
                };
                match invocation {
                    Some(ref fence) => fence.with_live(admit),
                    None => admit(),
                }
            })
    })();
    if result.is_err() {
        ownership.cancel_presentation(id);
    }
    result
}
// Used by protocol dispatch, not by plugins with a claimed window label.
pub(super) fn complete(
    ownership: &mut Ownership,
    window: &str,
    document: &str,
    id: &str,
    metadata: LayoutMetadata,
) -> Result<Value, &'static str> {
    ownership.complete_presentation(window, document, id, metadata)?;
    Ok(Value::Null)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetRequest {
    panel_id: String,
    presentation: Presentation,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloseRequest {
    panel_id: String,
}
pub(crate) async fn change(
    app: &AppHandle,
    owner: PluginLease,
    params: Value,
    close: bool,
) -> AppResult<Value> {
    let (panel, presentation) = if close {
        let r: CloseRequest = serde_json::from_value(params)
            .map_err(|_| AppError::validation("plugin.api.invalid:panelId"))?;
        (r.panel_id, None)
    } else {
        let r: SetRequest = serde_json::from_value(params)
            .map_err(|_| AppError::validation("plugin.api.invalid:presentation"))?;
        (r.panel_id, Some(r.presentation))
    };
    request(app, owner, panel, presentation).await
}

#[cfg(test)]
mod tests;
