use serde::Serialize;
use serde_json::Value;
use tauri::Emitter;

use super::api::{authorize, field, validate_params, HostContext};
use crate::error::{AppError, AppResult};

pub(super) const EVENT: &str = "plugin://event";

/// Identity always comes from the approved host runtime, never request fields.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PluginEvent {
    plugin_id: String,
    generation: u64,
    event: String,
    payload: Value,
}

pub(super) fn emit(context: &HostContext, event: &str, payload: Value) -> AppResult<()> {
    authorize(context, &[])?;
    context.app.emit(
        EVENT,
        PluginEvent {
            plugin_id: context.id.clone(),
            generation: context.generation,
            event: event.into(),
            payload,
        },
    )?;
    Ok(())
}

pub(super) fn publish(context: &HostContext, params: Value) -> AppResult<Value> {
    publish_with(&context.id, context.generation, params, |event| {
        authorize(context, &[])?;
        context.app.emit(EVENT, event)?;
        Ok(())
    })
}

fn publish_with(
    plugin_id: &str,
    generation: u64,
    params: Value,
    deliver: impl FnOnce(PluginEvent) -> AppResult<()>,
) -> AppResult<Value> {
    validate_params(&params)?;
    let event: String = field(&params, "event")?;
    if event.is_empty()
        || event.len() > 128
        || !event
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(AppError::validation("plugin.api.invalidEvent"));
    }
    deliver(PluginEvent {
        plugin_id: plugin_id.into(),
        generation,
        event,
        payload: params.get("payload").cloned().unwrap_or(Value::Null),
    })?;
    Ok(Value::Null)
}

#[cfg(test)]
pub(super) mod tests;
