//! Versioned RPC boundary: authorize, validate, route and fence the response.
mod catalogue;
mod domains;
mod routing;
mod transport;

pub use catalogue::{ApiMethod, METHODS};
pub(super) use domains::files::text::write_local;
pub(super) use transport::frontend::frontend_request;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

const MAX_PAYLOAD: usize = 1024 * 1024 - 4096;
const MAX_REQUEST: usize = 256 * 1024;
const CORE_CONTRACTS: &str = include_str!("contracts/core-v1.json");

#[derive(Clone)]
pub struct HostContext {
    pub app: AppHandle,
    pub id: String,
    pub fingerprint: String,
    pub permissions: Vec<String>,
    pub generation: u64,
    pub tool_client: Option<String>,
    pub tool_request: Option<uuid::Uuid>,
}

pub fn method_info(name: &str) -> Option<&'static ApiMethod> {
    METHODS.iter().find(|entry| entry.name == name)
}

pub(super) fn authorize(context: &HostContext, permissions: &[&str]) -> AppResult<()> {
    let state = context.app.state::<AppState>();
    state.plugins.security.authorize(
        &context.id,
        &context.fingerprint,
        &context.permissions,
        None,
        Some(context.generation),
    )?;
    for permission in permissions {
        state.plugins.security.authorize(
            &context.id,
            &context.fingerprint,
            &context.permissions,
            Some(permission),
            Some(context.generation),
        )?;
    }
    Ok(())
}

pub(super) fn field<T: DeserializeOwned>(params: &Value, key: &str) -> AppResult<T> {
    serde_json::from_value(
        params
            .get(key)
            .cloned()
            .ok_or_else(|| AppError::validation(format!("plugin.api.missing:{key}")))?,
    )
    .map_err(|_| AppError::validation(format!("plugin.api.invalid:{key}")))
}

pub(super) fn optional<T: DeserializeOwned>(params: &Value, key: &str) -> AppResult<Option<T>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| AppError::validation(format!("plugin.api.invalid:{key}"))),
    }
}

fn encode(value: impl Serialize) -> AppResult<Value> {
    Ok(serde_json::to_value(value)?)
}

pub(super) fn validate_params(params: &Value) -> AppResult<()> {
    if !params.is_object() || serde_json::to_vec(params)?.len() > MAX_REQUEST {
        return Err(AppError::validation("plugin.api.invalidParams"));
    }
    Ok(())
}

fn describe_api() -> Value {
    static CONTRACTS: OnceLock<Value> = OnceLock::new();
    let contracts = CONTRACTS.get_or_init(|| {
        serde_json::from_str(CORE_CONTRACTS).expect("embedded core contracts must be valid JSON")
    });
    let methods: Vec<Value> = METHODS
        .iter()
        .map(|method| {
            let mut description =
                serde_json::to_value(method).expect("method metadata must serialize");
            if let Some(contract) = contracts["methods"].get(method.name) {
                description["contract"] = contract.clone();
            }
            description
        })
        .collect();
    json!({"version":1,"methods":methods})
}

pub async fn dispatch(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let entry =
        method_info(method).ok_or_else(|| AppError::validation("plugin.api.unknownMethod"))?;
    authorize(context, entry.permissions)?;
    validate_params(&params)?;
    let result = routing::route(context, method, params).await?;
    // A revoked or replaced runtime must not receive a response after an await.
    authorize(context, entry.permissions)?;
    if serde_json::to_vec(&result)?.len() > MAX_PAYLOAD {
        return Err(AppError::validation("plugin.api.responseTooLarge"));
    }
    Ok(result)
}

// Stable native command entry points delegate to the frontend transport.
#[tauri::command]
pub fn plugin_workspace_authorize(request_id: String) -> AppResult<()> {
    transport::frontend::authorize_request(request_id)
}
#[tauri::command]
pub fn plugin_workspace_reply(
    request_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> AppResult<()> {
    transport::frontend::reply(request_id, result, error)
}

#[cfg(test)]
#[path = "contracts/tests.rs"]
mod contract_tests;

#[cfg(test)]
#[path = "api/tests/discovery.rs"]
mod tests;
