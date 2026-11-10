//! Bounded request/reply bridge with generation reauthorization and cancellation.
use crate::error::{AppError, AppResult};
use crate::plugins::api::{authorize, method_info, HostContext, MAX_PAYLOAD};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

const FRONTEND_EVENT: &str = "plugin://workspace-request";

struct PendingFrontend {
    context: HostContext,
    permissions: &'static [&'static str],
    reply: oneshot::Sender<AppResult<Value>>,
}
struct FrontendRequestGuard {
    app: AppHandle,
    request_id: String,
}
impl Drop for FrontendRequestGuard {
    fn drop(&mut self) {
        let removed = pending_frontend()
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&self.request_id));
        if removed.is_some() {
            let _ = self.app.emit(
                "plugin://workspace-cancelled",
                json!({"requestId": self.request_id}),
            );
        }
    }
}
fn pending_frontend() -> &'static Mutex<HashMap<String, PendingFrontend>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingFrontend>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(in crate::plugins) async fn frontend_request(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    // Internal frontend command delivery is not a public RPC capability.
    let permissions: &'static [&'static str] = if method == "__frontend.command" {
        &["ui.trusted"]
    } else {
        method_info(method)
            .ok_or_else(|| AppError::validation("plugin.api.unknownMethod"))?
            .permissions
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = pending_frontend()
            .lock()
            .map_err(|_| AppError::internal("plugin.api.lock"))?;
        if pending.len() >= 64
            || pending
                .values()
                .filter(|item| item.context.id == context.id)
                .count()
                >= 8
        {
            return Err(AppError::validation("plugin.api.busy"));
        }
        pending.insert(
            request_id.clone(),
            PendingFrontend {
                context: context.clone(),
                permissions,
                reply: sender,
            },
        );
    }
    let _guard = FrontendRequestGuard {
        app: context.app.clone(),
        request_id: request_id.clone(),
    };
    let result = async {
        context.app.emit(
            FRONTEND_EVENT,
            json!({"requestId":request_id,"pluginId":context.id,"method":method,"params":params}),
        )?;
        tokio::time::timeout(
            Duration::from_secs(if matches!(method, "ui.confirm" | "__frontend.command") {
                60
            } else {
                15
            }),
            receiver,
        )
        .await
        .map_err(|_| AppError::validation("plugin.api.frontendTimeout"))?
        .map_err(|_| AppError::validation("plugin.api.frontendClosed"))?
    }
    .await;
    result
}

pub(in crate::plugins::api) fn authorize_request(request_id: String) -> AppResult<()> {
    let pending = pending_frontend()
        .lock()
        .map_err(|_| AppError::internal("plugin.api.lock"))?;
    let request = pending
        .get(&request_id)
        .ok_or_else(|| AppError::validation("plugin.api.requestExpired"))?;
    authorize(&request.context, request.permissions)
}

pub(in crate::plugins::api) fn reply(
    request_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> AppResult<()> {
    let request = pending_frontend()
        .lock()
        .map_err(|_| AppError::internal("plugin.api.lock"))?
        .remove(&request_id)
        .ok_or_else(|| AppError::validation("plugin.api.requestExpired"))?;
    let result = authorize(&request.context, request.permissions)
        .and_then(|_| frontend_result(result, error));
    let _ = request.reply.send(result);
    Ok(())
}

pub(in crate::plugins::api) fn frontend_result(
    result: Option<Value>,
    error: Option<String>,
) -> AppResult<Value> {
    match error {
        Some(error) => Err(AppError::validation(format!(
            "plugin.api.frontend:{}",
            error.chars().take(512).collect::<String>()
        ))),
        None => {
            let result = result.unwrap_or(Value::Null);
            if serde_json::to_vec(&result)?.len() > MAX_PAYLOAD {
                Err(AppError::validation("plugin.api.responseTooLarge"))
            } else {
                Ok(result)
            }
        }
    }
}
