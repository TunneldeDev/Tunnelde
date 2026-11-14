//! Public experimental startup DTOs. The request broker belongs to the main
//! application and never borrows a plugin's security scope or connection lease.
mod schema;
#[cfg(test)]
pub(super) mod tests;
use crate::{automation::contract::Failure, error::AppError, services::forwarding::start};
pub(super) use schema::methods;
use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;

fn invalid() -> Failure {
    Failure::new(
        "invalid_request",
        "Invalid forwarding startup input; check api.describe",
    )
}
fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}
fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .ok()
        .is_some_and(|id| id.to_string() == value)
}
fn parse(params: Value) -> Result<start::receipt::Input, Failure> {
    let input: start::receipt::Input = serde_json::from_value(params).map_err(|_| invalid())?;
    if !token(&input.id) || !token(&input.revision) || !uuid(&input.request_id) {
        return Err(invalid());
    }
    Ok(input)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Query {
    request_id: String,
}
fn query(params: Value) -> Result<Query, Failure> {
    let input: Query = serde_json::from_value(params).map_err(|_| invalid())?;
    if !uuid(&input.request_id) {
        return Err(invalid());
    }
    Ok(input)
}
fn map(error: AppError) -> Failure {
    match error.to_string().as_str() {
        "forward.changed" | "ssh.connectionChanged" => Failure::new("stale_revision", "The rule or reviewed host changed; read current state and review again"),
        "forward.startUnknown" => Failure::new("operation_rejected", "Unknown or expired receipt; inspect forwards.list before using a NEW request UUID"),
        "forward.startReused" => Failure::new("operation_rejected", "This request UUID is already bound to different input"),
        "forward.startBusy" => Failure::new("operation_rejected", "Another forwarding prompt is pending or receipt capacity is full; retry later with the same UUID"),
        _ => {
            tracing::warn!(target: "automation.forwards", error_code=error.code(), "Forwarding startup request rejected");
            Failure::new("operation_rejected", "Cannot accept this forwarding request; inspect application logs and current forwarding state")
        }
    }
}
pub(super) fn call(app: &AppHandle, method: &str, params: Value) -> Result<Value, Failure> {
    let receipt = match method {
        "forwards.start" => start::begin(app, parse(params)?),
        "forwards.startStatus" => start::status(app, &query(params)?.request_id),
        "forwards.cancelStart" => start::cancel(app, &query(params)?.request_id),
        _ => {
            return Err(Failure::new(
                "unknown_method",
                "Unknown forwarding startup method",
            ))
        }
    }
    .map_err(map)?;
    serde_json::to_value(receipt)
        .map_err(|_| Failure::new("internal", "Cannot encode forwarding receipt"))
}
