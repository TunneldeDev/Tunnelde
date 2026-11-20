//! In-memory, generation-scoped plugin messaging. Private traffic never uses Tauri events.
mod broker;
use super::{
    api::{field, optional, HostContext},
    security::{Lease, PluginSecurity},
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use broker::{Book, Signal};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Manager;

const PERMISSION: &[&str] = &["bus.communicate"];
const WAIT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Peer {
    id: String,
    generation: u64,
}

#[derive(Default)]
pub(super) struct Bus(Mutex<Book>);

impl Bus {
    fn edit<T>(&self, f: impl FnOnce(&mut Book) -> T) -> T {
        f(&mut self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub(super) fn retire_before(&self, id: &str, boundary: u64) {
        self.edit(|book| book.retire_before(id, boundary));
    }
}

fn invalid() -> AppError {
    AppError::validation("plugin.bus.invalid")
}
fn denied() -> AppError {
    AppError::validation("plugin.bus.unavailable")
}
fn limit() -> AppError {
    AppError::validation("plugin.bus.limit")
}

fn name(params: &Value, key: &str) -> AppResult<String> {
    let name: String = field(params, key)?;
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    {
        return Err(invalid());
    }
    Ok(name)
}

pub(super) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let state = context.app.state::<AppState>();
    let lease = Lease {
        id: context.id.clone(),
        generation: context.generation,
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
    };
    call(
        &state.plugins.bus,
        &state.plugins.security,
        &lease,
        method,
        params,
    )
    .await
}

async fn call(
    bus: &Bus,
    security: &PluginSecurity,
    lease: &Lease,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let peer = Peer {
        id: lease.id.clone(),
        generation: lease.generation,
    };
    let admitted = |f: &mut dyn FnMut(&mut Book) -> AppResult<Value>| {
        crate::platform::panel_windows::plugin_views::origin::with_current(|| {
            security.with_authorized(lease, PERMISSION, || bus.edit(f))
        })
    };
    if method == "bus.receive" {
        let signal: Arc<Signal> =
            crate::platform::panel_windows::plugin_views::origin::with_current(|| {
                security.with_authorized(lease, PERMISSION, || bus.edit(|book| book.signal(&peer)))
            })?;
        let _receiver = signal
            .receiver
            .try_acquire()
            .map_err(|_| AppError::validation("plugin.bus.receiveBusy"))?;
        return security
            .guard(lease, async {
                let drain = || admitted(&mut |book| book.drain(&peer));
                let wait = async {
                    loop {
                        let ready = signal.ready.notified();
                        let batch = drain()?;
                        if batch["lost"] != 0
                            || batch["messages"]
                                .as_array()
                                .is_some_and(|items| !items.is_empty())
                        {
                            return Ok(batch);
                        }
                        ready.await;
                    }
                };
                match tokio::time::timeout(WAIT, wait).await {
                    Ok(result) => result,
                    Err(_) => drain(),
                }
            })
            .await;
    }
    admitted(&mut |book| match method {
        "bus.advertise" => {
            let capability = name(&params, "capability")?;
            let version = optional::<u32>(&params, "version")?;
            book.advertise(&peer, capability, version)?;
            Ok(Value::Null)
        }
        "bus.discover" => book.discover(&peer, &name(&params, "capability")?),
        "bus.snapshot" => book.snapshot(&peer),
        "bus.decline" => {
            book.decline(&peer, &name(&params, "invitationId")?)?;
            Ok(Value::Null)
        }
        "bus.create" => book.create(&peer).map(Value::String),
        "bus.invite" => book
            .invite(&peer, &name(&params, "busId")?, &name(&params, "pluginId")?)
            .map(Value::String),
        "bus.invitations" => book.invitations(&peer),
        "bus.join" => book
            .join(&peer, &name(&params, "invitationId")?)
            .map(Value::String),
        "bus.leave" | "bus.close" => {
            book.leave(&peer, &name(&params, "busId")?, method == "bus.close")?;
            Ok(Value::Null)
        }
        "bus.subscribe" | "bus.unsubscribe" | "bus.publish" => {
            let id = optional::<String>(&params, "busId")?;
            let topic = name(&params, "topic")?;
            let id = id.as_deref();
            match method {
                "bus.publish" => {
                    if topic.starts_with("bus.") {
                        return Err(invalid());
                    }
                    let payload = params.get("payload").cloned().unwrap_or(Value::Null);
                    if serde_json::to_vec(&payload)?.len() > 16 * 1024 {
                        return Err(limit());
                    }
                    Ok(json!({"recipients":book.publish(&peer, id, topic, payload)?}))
                }
                _ => {
                    book.subscribe(&peer, id, topic, method == "bus.subscribe")?;
                    Ok(Value::Null)
                }
            }
        }
        _ => Err(invalid()),
    })
}

#[cfg(test)]
mod integration;
