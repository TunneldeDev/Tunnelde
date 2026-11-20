//! Closed, private native PTY broker. Main binds an existing user-managed PTY;
//! a satellite never receives an SSH handle or arbitrary session selector.
use super::{
    native,
    ownership::{Lease, Ownership, MAIN},
};
use crate::{
    error::AppResult,
    ssh::terminal_presentation::{Authorization, Endpoint, Operation},
    state::AppState,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};

pub(super) struct Source {
    document: String,
    endpoint: Endpoint,
}
#[derive(Default)]
pub(super) struct Resources {
    sources: HashMap<String, Arc<Source>>,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Output {
    sequence: u64,
    data: String,
}
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Bind { session_id: String },
    Unbind { panel_id: String },
    Detach { lease: Lease },
    Write { lease: Lease, data: String },
    Resize { lease: Lease, cols: u32, rows: u32 },
}
impl Ownership {
    pub(super) fn retire_terminal(&mut self, panel: &str) {
        self.terminals.sources.remove(panel);
    }
    pub(super) fn terminal_registered(&self, panel: &str) -> bool {
        self.terminals.sources.get(panel).is_some_and(|source| {
            self.document(MAIN) == Some(source.document.as_str()) && !source.endpoint.closed()
        })
    }
    fn bind_terminal(
        &mut self,
        window: &str,
        document: &str,
        endpoint: Endpoint,
    ) -> Result<Lease, &'static str> {
        self.main(window, document)?;
        let id = uuid::Uuid::parse_str(&endpoint.session_id).map_err(|_| "invalid terminal")?;
        let panel_id = format!("terminal:{id}");
        if endpoint.closed() {
            return Err("ssh.sessionMissing");
        }
        if let Some(previous) = self.terminals.sources.get(&panel_id) {
            if !previous.endpoint.same(&endpoint) {
                return Err("stale terminal resource");
            }
            if previous.document == document {
                return self
                    .panels
                    .get(&panel_id)
                    .map(|panel| panel.lease.clone())
                    .ok_or("panel not found");
            }
        } else if self.panels.contains_key(&panel_id) {
            // addPanel by itself cannot authorize a caller-chosen terminal ID.
            return Err("unbound terminal panel");
        }
        let lease = if let Some(panel) = self.panels.get(&panel_id) {
            if !panel.native_actions.is_empty() {
                return Err("panel interaction in progress");
            }
            panel.lease.clone()
        } else {
            self.add_panel(window, document, &panel_id)?
        };
        self.terminals.sources.insert(
            panel_id,
            Arc::new(Source {
                document: document.into(),
                endpoint,
            }),
        );
        Ok(lease)
    }
    fn terminal_current(
        &self,
        window: &str,
        document: &str,
        lease: &Lease,
        source: &Arc<Source>,
        input: bool,
    ) -> Result<(), &'static str> {
        self.owned(window, document, lease)?;
        if input {
            self.resource_action(window, document, lease)?;
        }
        let current = self
            .terminals
            .sources
            .get(&lease.panel_id)
            .ok_or("stale terminal resource")?;
        if !Arc::ptr_eq(current, source) || self.document(MAIN) != Some(source.document.as_str()) {
            return Err("stale terminal resource");
        }
        Ok(())
    }
    fn begin_terminal(
        &mut self,
        window: &str,
        document: &str,
        lease: &Lease,
    ) -> Result<(Arc<Source>, String), &'static str> {
        let source = self
            .terminals
            .sources
            .get(&lease.panel_id)
            .cloned()
            .ok_or("unbound terminal panel")?;
        self.terminal_current(window, document, lease, &source, true)?;
        if source.endpoint.closed() {
            return Err("ssh.sessionMissing");
        }
        let panel = self.panels.get_mut(&lease.panel_id).unwrap();
        if panel.native_actions.len() >= 64 {
            return Err("ssh.sessionBusy");
        }
        let id = uuid::Uuid::new_v4().to_string();
        panel.native_actions.insert(id.clone());
        Ok((source, id))
    }
}
struct Effect {
    app: AppHandle,
    lease: Lease,
    id: String,
}
impl Drop for Effect {
    fn drop(&mut self) {
        let registry = self.app.state::<native::Registry>();
        native::lock(&registry).finish_native_action(&self.lease.panel_id, &self.id);
        native::changed(&self.app);
    }
}

#[tauri::command]
pub(crate) async fn panel_window_terminal(
    window: WebviewWindow,
    document: String,
    request: Request,
) -> AppResult<Value> {
    let app = window.app_handle().clone();
    let caller = window.label().to_owned();
    let registry = app.state::<native::Registry>();
    // Bind only a concrete, existing, published user-managed PTY. Never connect,
    // authenticate, reopen or expose plugin/dedicated background transports.
    if let Request::Bind { session_id } = &request {
        native::lock(&registry)
            .main(&caller, &document)
            .map_err(native::invalid)?;
        let endpoint = app.state::<AppState>().ssh.terminal_endpoint(session_id)?;
        let lease = native::lock(&registry)
            .bind_terminal(&caller, &document, endpoint)
            .map_err(native::invalid)?;
        native::changed(&app);
        return Ok(json!(lease));
    }
    if let Request::Unbind { panel_id } = &request {
        let mut ownership = native::lock(&registry);
        ownership
            .main(&caller, &document)
            .map_err(native::invalid)?;
        if !ownership.terminals.sources.contains_key(panel_id) {
            return Err(native::invalid("unbound terminal panel"));
        }
        ownership
            .remove_panel(&caller, &document, panel_id)
            .map_err(native::invalid)?;
        ownership.terminals.sources.remove(panel_id);
        drop(ownership);
        native::changed(&app);
        return Ok(Value::Null);
    }
    match request {
        Request::Detach { lease } => {
            execute(&app, &caller, &document, lease, Operation::Detach).await
        }
        Request::Write { lease, data } => {
            if data.len() > 128 * 1024 {
                return Err(native::invalid("ssh.invalidPayload"));
            }
            let bytes = BASE64
                .decode(data)
                .map_err(|_| native::invalid("ssh.invalidPayload"))?;
            if bytes.is_empty() || bytes.len() > 64 * 1024 {
                return Err(native::invalid("ssh.invalidPayload"));
            }
            execute(&app, &caller, &document, lease, Operation::Write(bytes)).await
        }
        Request::Resize { lease, cols, rows } => {
            if cols == 0 || rows == 0 || cols > 4096 || rows > 4096 {
                return Err(native::invalid("ssh.invalidPayload"));
            }
            execute(
                &app,
                &caller,
                &document,
                lease,
                Operation::Resize { cols, rows },
            )
            .await
        }
        _ => unreachable!(),
    }
}

#[tauri::command]
pub(crate) async fn panel_window_terminal_attach(
    window: WebviewWindow,
    document: String,
    lease: Lease,
    output: Channel<Output>,
) -> AppResult<Value> {
    let app = window.app_handle().clone();
    let caller = window.label().to_owned();
    let registry = app.state::<native::Registry>();
    let source = native::lock(&registry)
        .terminals
        .sources
        .get(&lease.panel_id)
        .cloned()
        .ok_or_else(|| native::invalid("unbound terminal panel"))?;
    let sink_app = app.clone();
    let sink_caller = caller.clone();
    let sink_document = document.clone();
    let sink_lease = lease.clone();
    let sink = Arc::new(move |sequence, bytes: &[u8]| {
        let registry = sink_app.state::<native::Registry>();
        let ownership = native::lock(&registry);
        // Keep the exact ownership guard through delivery. Commit/reload
        // cannot race validation and leak a final packet to the old owner.
        ownership
            .terminal_current(&sink_caller, &sink_document, &sink_lease, &source, false)
            .is_ok()
            && output
                .send(Output {
                    sequence,
                    data: BASE64.encode(bytes),
                })
                .is_ok()
    });
    execute(&app, &caller, &document, lease, Operation::Attach(sink)).await
}

async fn execute(
    app: &AppHandle,
    caller: &str,
    document: &str,
    lease: Lease,
    operation: Operation,
) -> AppResult<Value> {
    let registry = app.state::<native::Registry>();
    let (source, id) = native::lock(&registry)
        .begin_terminal(caller, document, &lease)
        .map_err(native::invalid)?;
    let effect = Effect {
        app: app.clone(),
        lease: lease.clone(),
        id,
    };
    let endpoint = source.endpoint.clone();
    let check_app = app.clone();
    let caller = caller.to_owned();
    let document = document.to_owned();
    let authorization = Authorization {
        current: Arc::new(move || {
            native::lock(&check_app.state::<native::Registry>())
                .terminal_current(&caller, &document, &lease, &source, true)
                .is_ok()
        }),
        retention: Box::new(effect),
    };
    endpoint
        .request(authorization, operation)
        .await
        .map(|sequence| json!(sequence))
}

#[cfg(test)]
mod tests;
