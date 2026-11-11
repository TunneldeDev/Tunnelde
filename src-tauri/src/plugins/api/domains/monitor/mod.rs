use crate::plugins::api::{encode, field, HostContext};
use crate::{
    commands,
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::Value;
use tauri::Manager;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let app = &context.app;
    let state = app.state::<AppState>();
    match method {
        "monitor.system" => encode(commands::system_stats(state)),
        "monitor.stats" => {
            encode(commands::remote_stats(app.clone(), field(&params, "sessionId")?).await?)
        }
        "monitor.processes" => {
            encode(commands::remote_processes(app.clone(), field(&params, "sessionId")?).await?)
        }
        "monitor.kill" => {
            commands::remote_kill(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "pid")?,
                None,
            )
            .await?;
            Ok(Value::Null)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
