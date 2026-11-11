//! Profile read adapter. Large projections run outside the GUI thread.
use crate::plugins::api::transport::operation::Operation;
use crate::{
    error::{AppError, AppResult},
    plugins::api::{authorize, encode, HostContext},
    settings_profiles::{content, observation},
    state::AppState,
};
use serde_json::Value;
use std::sync::{Arc, OnceLock};
use tauri::Manager;
use tokio::sync::Semaphore;

pub(super) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    if matches!(method, "profiles.catalogue" | "profiles.read") {
        let request = if method == "profiles.read" {
            Some(
                serde_json::from_value::<content::contracts::Read>(params)
                    .map_err(|_| AppError::validation("profiles.content.invalidRequest"))?,
            )
        } else {
            serde_json::from_value::<content::contracts::Empty>(params)
                .map_err(|_| AppError::validation("profiles.content.invalidRequest"))?;
            None
        };
        static CAPACITY: OnceLock<Arc<Semaphore>> = OnceLock::new();
        let operation =
            Operation::admit(CAPACITY.get_or_init(|| Arc::new(Semaphore::new(4))).clone())?;
        let ticket = operation.ticket();
        let worker = context.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let state = worker.app.state::<AppState>();
            let check = || {
                ticket.check()?;
                authorize(&worker, &["settings.read"])
            };
            (match request {
                Some(request) => content::read(&state.db, request, check).and_then(encode),
                None => content::catalogue(&state.db, check).and_then(encode),
            })
            .map_err(|error| {
                let message = error.to_string();
                if message.starts_with("pluginSecurity.")
                    || message.starts_with("profiles.")
                    || message == "plugin.api.cancelled"
                {
                    error
                } else {
                    AppError::validation("profiles.content.unavailable")
                }
            })
        })
        .await
        .map_err(|_| AppError::internal("profiles.content.unavailable"))?;
    }
    if method != "profiles.observe" {
        return Err(AppError::validation("plugin.api.unknownMethod"));
    }
    let request: observation::contracts::Observe = serde_json::from_value(params)
        .map_err(|_| AppError::validation("plugin.api.invalid:params"))?;
    authorize(context, &["settings.read"])?;
    let state = context.app.state::<AppState>();
    let response = state.db.with(|conn| observation::observe(conn, request))?;
    authorize(context, &["settings.read"])?;
    encode(response)
}
