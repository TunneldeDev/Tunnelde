//! Adapt the public command contract to a cancellation-safe SSH exchange.
use crate::plugins::api::{authorize, field, optional, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::Value;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::Manager;
use tokio::sync::Semaphore;

mod exchange;

pub(in crate::plugins::api) async fn execute(
    context: &HostContext,
    params: &Value,
) -> AppResult<Value> {
    let session_id: String = field(params, "sessionId")?;
    let command: String = field(params, "command")?;
    let timeout = optional::<u64>(params, "timeoutMs")?.unwrap_or(20_000);
    if !(100..=60_000).contains(&timeout)
        || command.trim().is_empty()
        || command.len() > 64 * 1024
        || command.contains('\0')
    {
        return Err(AppError::validation("plugin.api.invalidExec"));
    }
    let state = context.app.state::<AppState>();
    let identity = state.ssh.identity(&session_id)?;
    let handle = state.ssh.handle(&session_id)?;
    static OPENS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    exchange::run(
        handle,
        command,
        Duration::from_secs(8),
        Duration::from_millis(timeout),
        || {
            authorize(context, &["ssh.exec"])?;
            if let Some(origin) = crate::platform::panel_windows::plugin_views::origin::current() {
                origin.authorize_call(crate::plugins::frontend::native::CallPolicy::OwnedData)?;
            }
            if state.ssh.identity(&session_id)? != identity {
                return Err(AppError::validation("ssh.sessionMissing"));
            }
            Ok(())
        },
        OPENS.get_or_init(|| Arc::new(Semaphore::new(16))).clone(),
    )
    .await
}
