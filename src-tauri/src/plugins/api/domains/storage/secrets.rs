use super::storage_key;
use crate::error::{AppError, AppResult};
use crate::plugins::{
    api::{encode, field, HostContext},
    security::Lease,
};
use crate::services::operations::Cancellation;
use serde_json::Value;
use tauri::Manager;

#[cfg(test)]
mod tests;

async fn run<T: Send + 'static>(
    admit: impl FnOnce(&Cancellation) -> AppResult<()> + Send + 'static,
    operation: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    crate::services::credentials::checked(move |job| {
        // Cancelled callers must not launch a queued keyring operation. Once
        // admitted, a write/delete settles even if its caller disappears.
        // No policy/database guard spans the platform operation.
        admit(job)?;
        operation()
    })
    .await
}

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: &Value,
) -> AppResult<Value> {
    let key = storage_key(params)?;
    let identity = format!("plugin:{}:{}", context.id, key);
    let value: Option<String> = if method == "secrets.set" {
        Some(field(params, "value")?)
    } else {
        None
    };
    if value.as_ref().is_some_and(|value| value.len() > 16 * 1024) {
        return Err(AppError::validation("plugin.api.secretTooLarge"));
    }
    let method = method.to_owned();
    let context = context.clone();
    let checked_context = context.clone();
    run(
        move |job| {
            let lease = Lease {
                id: checked_context.id.clone(),
                fingerprint: checked_context.fingerprint.clone(),
                permissions: checked_context.permissions.clone(),
                generation: checked_context.generation,
            };
            checked_context
                .app
                .state::<crate::state::AppState>()
                .plugins
                .security
                .with_authorized(&lease, &["secrets"], || {
                    crate::plugins::tools::with_request_authorized(
                        &lease.id,
                        lease.generation,
                        checked_context.tool_client.as_deref(),
                        checked_context.tool_request,
                        || job.commit(),
                    )
                })
        },
        move || {
            let state = context.app.state::<crate::state::AppState>();
            match method.as_str() {
                "secrets.get" => encode(state.vault.load(&identity)?),
                "secrets.set" => {
                    state
                        .vault
                        .save(&identity, value.as_deref().unwrap_or_default())?;
                    Ok(Value::Null)
                }
                "secrets.delete" => {
                    state.vault.forget(&identity)?;
                    Ok(Value::Null)
                }
                _ => Err(AppError::validation("plugin.api.unknownMethod")),
            }
        },
    )
    .await
}
