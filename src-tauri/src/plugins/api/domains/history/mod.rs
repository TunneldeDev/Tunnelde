use crate::plugins::api::{encode, field, optional, HostContext};
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
        "history.list" => encode(commands::history_list(
            app.clone(),
            state,
            field(&params, "hostId")?,
            optional(&params, "limit")?,
        )?),
        "history.record" => encode(commands::history_record(
            app.clone(),
            state,
            field(&params, "hostId")?,
            field(&params, "command")?,
        )?),
        "history.delete" => {
            commands::history_delete(app.clone(), state, field(&params, "id")?)?;
            Ok(Value::Null)
        }
        "history.clear" => {
            commands::history_clear(app.clone(), state, field(&params, "hostId")?)?;
            Ok(Value::Null)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
