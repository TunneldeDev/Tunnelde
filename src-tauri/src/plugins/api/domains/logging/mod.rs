//! Read-only transport; worker permits survive cancellation of their async owner.
use crate::{
    error::{AppError, AppResult},
    logs::read::{self, contracts::Request},
    plugins::api::{authorize, encode, HostContext},
    state::AppState,
};
use serde_json::Value;
use std::sync::{Arc, OnceLock};
use tauri::Manager;
use tokio::sync::Semaphore;
mod operation;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    if method != "logs.read" {
        return Err(AppError::validation("plugin.api.unknownMethod"));
    }
    let request: Request = serde_json::from_value(params)
        .map_err(|_| AppError::validation("logs.read.invalidRequest"))?;
    static CAPACITY: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let operation =
        operation::Operation::admit(CAPACITY.get_or_init(|| Arc::new(Semaphore::new(4))).clone())?;
    let ticket = operation.ticket();
    let worker = context.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker.app.state::<AppState>();
        let owner = format!("{}:{}:{}", worker.id, worker.fingerprint, worker.generation);
        read::read(&state.log_dir, &state.db, &owner, request, || {
            ticket.check()?;
            authorize(&worker, &["logs.read"])
        })
        .and_then(encode)
        .map_err(|error| {
            let message = error.to_string();
            if message.starts_with("pluginSecurity.")
                || message == "plugin.api.cancelled"
                || message.starts_with("logs.read.")
            {
                error
            } else {
                AppError::validation("logs.read.unavailable")
            }
        })
    })
    .await
    .map_err(|_| AppError::internal("logs.read.unavailable"))?
}
