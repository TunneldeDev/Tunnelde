//! Private builtin forwarding ingress. No arbitrary invoke, provider authority,
//! credentials or caller-chosen native identity. Transfer admission is separate.
mod request;
use super::{
    native,
    ownership::{Lease, Ownership},
};
use crate::{
    error::{AppError, AppResult},
    services::forwarding as domain,
    state::AppState,
};
use request::Request;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

impl Ownership {
    fn forwarding_current(
        &self,
        window: &str,
        document: &str,
        lease: &Lease,
        request: &Request,
    ) -> Result<(), &'static str> {
        if lease.panel_id != "forwarding" {
            return Err("unsupported panel action");
        }
        self.resource_action(window, document, lease)?;
        if let Some(interaction) = request.interaction() {
            self.require_interaction(window, document, lease, interaction)?;
        }
        Ok(())
    }
    fn begin_forwarding(
        &mut self,
        window: &str,
        document: &str,
        lease: &Lease,
        request: &Request,
    ) -> Result<String, &'static str> {
        request.validate()?;
        self.forwarding_current(window, document, lease, request)?;
        // One actual operation per panel, independent of JS response delivery.
        if !self.panels[&lease.panel_id].native_actions.is_empty() {
            return Err("panel action in progress");
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.relay_fence(&lease.panel_id, &id, true)?;
        Ok(id)
    }
}

struct Effect {
    app: AppHandle,
    window: String,
    document: String,
    lease: Lease,
    id: String,
}
impl Effect {
    fn with_current<T>(
        &self,
        request: &Request,
        run: impl FnOnce() -> AppResult<T>,
    ) -> AppResult<T> {
        let registry = self.app.state::<native::Registry>();
        let ownership = native::lock(&registry);
        ownership
            .forwarding_current(&self.window, &self.document, &self.lease, request)
            .map_err(native::invalid)?;
        if !ownership.panels[&self.lease.panel_id]
            .native_actions
            .contains(&self.id)
        {
            return Err(native::invalid("panel action expired"));
        }
        // Ownership -> automation (stop/removal) -> registry -> DB. No awaits,
        // native UI or calls back into ownership inside this transaction.
        run()
    }
}
impl Drop for Effect {
    fn drop(&mut self) {
        native::lock(&self.app.state::<native::Registry>())
            .finish_native_action(&self.lease.panel_id, &self.id);
        native::changed(&self.app);
    }
}

#[tauri::command]
pub(crate) async fn panel_window_forwarding(
    window: WebviewWindow,
    document: String,
    lease: Lease,
    request: Request,
) -> AppResult<Value> {
    let app = window.app_handle().clone();
    let id = native::lock(&app.state::<native::Registry>())
        .begin_forwarding(window.label(), &document, &lease, &request)
        .map_err(native::invalid)?;
    let effect = Effect {
        app: app.clone(),
        window: window.label().into(),
        document,
        lease,
        id,
    };
    native::changed(&app);
    // Move the actual-effect guard INSIDE the worker. Dropping IPC delivery or
    // reloading the coordinator cannot unlock a still-running native operation.
    tauri::async_runtime::spawn(async move {
        let prepared = tauri::async_runtime::spawn_blocking(move || {
            let result = effect.with_current(&request, || prepare(&effect.app, &request));
            (effect, result)
        })
        .await
        .map_err(|_| AppError::internal("forward.invalid"))?;
        let (effect, result) = prepared;
        let outcome = match result? {
            Prepared::Value(value) => Ok(value),
            Prepared::Stop(stopping) => {
                domain::automation::changed(&effect.app);
                stopping.finish().await.map(|()| Value::Null)
            }
        };
        drop(effect);
        outcome
    })
    .await
    .map_err(|_| AppError::internal("forward.invalid"))?
}

enum Prepared {
    Value(Value),
    Stop(crate::ssh::forward::StoppedForward),
}
fn prepare(app: &AppHandle, request: &Request) -> AppResult<Prepared> {
    let state = app.state::<AppState>();
    let value = match request {
        Request::Save {
            rule,
            revision,
            group_id,
            automation,
            ..
        } => {
            let entry = domain::save_grouped(
                app,
                rule.clone(),
                revision.as_deref(),
                *automation,
                group_id.as_deref(),
            )?;
            domain::automation::changed(app);
            json!(domain::automation::ConfiguredRule {
                entry,
                automation: *automation
            })
        }
        Request::Stop {
            id,
            revision,
            runtime_id,
        } => {
            return Ok(Prepared::Stop(domain::take_manual_stop(
                app,
                id,
                revision,
                runtime_id.as_deref(),
            )?));
        }
        Request::Remove {
            id,
            revision,
            runtime_id,
            ..
        } => {
            return Ok(Prepared::Stop(domain::take_manual_remove(
                app,
                id,
                revision,
                runtime_id.as_deref(),
            )?));
        }
        Request::SaveGroup {
            host_id,
            name,
            id,
            revision,
        } => {
            let group = state.db.with(|conn| {
                crate::db::atomic(conn, |conn| {
                    domain::groups::save_at(conn, id.as_deref(), host_id, name, revision.as_deref())
                })
            })?;
            domain::automation::changed(app);
            json!(group)
        }
        Request::RemoveGroup { id, revision } => {
            domain::groups::remove(&state.db, &state.forwards, id, revision)?;
            domain::automation::changed(app);
            Value::Null
        }
    };
    Ok(Prepared::Value(value))
}

#[cfg(test)]
mod tests;
