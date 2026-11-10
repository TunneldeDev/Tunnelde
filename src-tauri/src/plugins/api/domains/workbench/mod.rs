use crate::error::{AppError, AppResult};
use crate::plugins::api::{frontend_request, HostContext};
use serde_json::Value;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    match method {
        "statusBar.set" | "statusBar.remove" => {
            crate::plugins::status_bar::call(context, method, params)
        }
        "tabBar.set" | "tabBar.remove" => crate::plugins::tab_bar::call(context, method, params),
        name if name.starts_with("workspace.")
            || name.starts_with("ui.")
            || name.starts_with("editor.") =>
        {
            frontend_request(context, name, params).await
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
