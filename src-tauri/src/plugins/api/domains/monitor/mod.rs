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
    let check = |policy| crate::platform::panel_windows::plugin_views::origin::check(policy);
    match method {
        "monitor.system" => {
            let staged = crate::plugins::frontend::native::CallPolicy::StagedData;
            check(staged)?;
            let value = encode(commands::system_stats(state));
            check(staged)?;
            value
        }
        "monitor.stats" => {
            let owned = crate::plugins::frontend::native::CallPolicy::OwnedData;
            check(owned)?;
            let value =
                encode(commands::remote_stats(app.clone(), field(&params, "sessionId")?).await?);
            check(owned)?;
            value
        }
        "monitor.processes" => {
            let owned = crate::plugins::frontend::native::CallPolicy::OwnedData;
            check(owned)?;
            let value = encode(
                commands::remote_processes(app.clone(), field(&params, "sessionId")?).await?,
            );
            check(owned)?;
            value
        }
        "monitor.killTree" | "monitor.executable" => {
            let owned = crate::plugins::frontend::native::CallPolicy::OwnedData;
            check(owned)?;
            let session = field(&params, "sessionId")?;
            let pid = field(&params, "pid")?;
            let start = field(&params, "expectedStartTicks")?;
            let value = if method == "monitor.killTree" {
                commands::remote_kill_tree(app.clone(), session, pid, start).await?;
                Value::Null
            } else {
                encode(
                    commands::remote_process_executable(app.clone(), session, pid, start).await?,
                )?
            };
            check(owned)?;
            Ok(value)
        }
        "monitor.kill" => {
            // Monitor reads and the process mutation all retain the original
            // native origin through their actual SSH dispatch.
            let owned = crate::plugins::frontend::native::CallPolicy::OwnedData;
            check(owned)?;
            commands::remote_kill(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "pid")?,
                None,
            )
            .await?;
            check(owned)?;
            Ok(Value::Null)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
