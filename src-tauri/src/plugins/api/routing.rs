//! Routing only. Permission checks and response fencing belong to dispatch.
use super::{domains, HostContext};
use crate::{
    error::{AppError, AppResult},
    plugins,
};
use serde_json::{json, Value};
use tauri::Emitter;

pub(super) async fn route(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let change_session = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let namespace = method.split('.').next().unwrap_or_default();
    let result = match namespace {
        "api" if method == "api.describe" => Ok(super::describe_api()),
        "extensions" if method == "extensions.describe" => Ok(plugins::extensions::describe()),
        "log" if method == "log" => {
            plugins::logging::write(&context.id, context.generation, params)
        }
        "app" => domains::application::dispatch(context, method, params).await,
        "settings" | "preferences" => domains::settings::dispatch(context, method, params).await,
        "configuration" => plugins::configuration::rpc::call(context, method, params).await,
        "hosts" | "groups" | "hostList" => domains::hosts::dispatch(context, method, params).await,
        "sessions" => domains::connections::dispatch(context, method, params).await,
        "terminal" => domains::terminal::dispatch(context, method, params).await,
        "files" => domains::files::dispatch(context, method, params).await,
        "monitor" => domains::monitor::dispatch(context, method, params).await,
        "history" => domains::history::dispatch(context, method, params).await,
        "clipboard" => domains::clipboard::dispatch(context, method, params).await,
        "storage" => domains::storage::dispatch(context, method, &params).await,
        "secrets" => domains::storage::secret(context, method, &params).await,
        "statusBar" | "tabBar" | "workspace" | "ui" | "editor" => {
            domains::workbench::dispatch(context, method, params).await
        }
        "forwards" => domains::forwarding::dispatch(context, method, params).await,
        "mounts" => {
            crate::mounts::action(
                context.app.clone(),
                context.id.clone(),
                method.trim_start_matches("mounts.").into(),
                params,
                Some(context.generation),
            )
            .await
        }
        "events" if method == "events.publish" => plugins::events::publish(context, params),
        "tasks" => plugins::tasks::dispatch(context, method, params).await,
        "runners" => plugins::runners::dispatch(context, method, params).await,
        "tools" => match method {
            "tools.invoke" => plugins::tools::invoke(context, params).await,
            _ => plugins::tools::cancel(context, method, &params).await,
        },
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }?;
    if let Some(domain) = changed_domain(method) {
        let _ = context.app.emit(
            "plugin://domain-changed",
            json!({"domain":domain,"sessionId":change_session}),
        );
    }
    Ok(result)
}

fn changed_domain(method: &str) -> Option<&'static str> {
    match method {
        "sessions.connect" | "sessions.disconnect" | "sessions.requestHandoff" => Some("sessions"),
        name if name.starts_with("files.")
            && !matches!(
                name,
                "files.upload"
                    | "files.download"
                    | "files.cancelTransfer"
                    | "files.transferStatus"
                    | "files.local.writeText"
                    | "files.local.copy"
                    | "files.sftp.copy"
            )
            && !name.ends_with(".readText")
            && !name.ends_with(".list")
            && !name.ends_with(".home") =>
        {
            Some("files")
        }
        _ => None,
    }
}
