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
    let check = || {
        if let Some(origin) = crate::platform::panel_windows::plugin_views::origin::current() {
            origin.authorize_call(crate::plugins::frontend::native::CallPolicy::OwnedData)?;
        }
        Ok::<(), AppError>(())
    };
    match method {
        "monitor.system" => encode(commands::system_stats(state)),
        "monitor.stats" => {
            check()?;
            let value =
                encode(commands::remote_stats(app.clone(), field(&params, "sessionId")?).await?);
            check()?;
            value
        }
        "monitor.processes" => {
            check()?;
            let value = encode(
                commands::remote_processes(app.clone(), field(&params, "sessionId")?).await?,
            );
            check()?;
            value
        }
        "monitor.kill" => {
            // Monitor reads and the process mutation all retain the original
            // native origin through their actual SSH dispatch.
            check()?;
            commands::remote_kill(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "pid")?,
                None,
            )
            .await?;
            check()?;
            Ok(Value::Null)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
