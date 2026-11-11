//! Domain transport: reads, staged writes and native consent are separate paths.
mod activation;
mod mutation;
mod read;
use crate::{
    error::{AppError, AppResult},
    plugins::api::HostContext,
};
use serde_json::Value;

pub(super) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    if matches!(
        method,
        "profiles.observe" | "profiles.catalogue" | "profiles.read"
    ) {
        return read::dispatch(context, method, params).await;
    }
    // Scoped AI/MCP tools have a separate allowlist and resource lifecycle;
    // adding public plugin RPCs does not extend their delegated authority.
    if context.tool_client.is_some() || context.tool_request.is_some() {
        return Err(AppError::validation("plugin.tools.methodDenied"));
    }
    mutation::dispatch(context, method, params)
        .await
        .map_err(redacted)
}
fn redacted(error: AppError) -> AppError {
    let text = error.to_string();
    if text.starts_with("pluginSecurity.")
        || text == "plugin.api.cancelled"
        || text.starts_with("plugin.api.frontend")
        || text.starts_with("preferences.invalidValue:")
        || text == "preferences.staleRevision"
        || text.starts_with("profiles.")
        || text == "settings.cssRejected"
    {
        error
    } else {
        AppError::validation("profiles.mutation.unavailable")
    }
}
fn parse<T: serde::de::DeserializeOwned>(params: Value) -> AppResult<T> {
    serde_json::from_value(params)
        .map_err(|_| AppError::validation("profiles.mutation.invalidRequest"))
}
