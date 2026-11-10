use crate::plugins::api::{encode, field, HostContext};
use crate::{
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
        "hosts.snapshot" => encode(crate::services::hosts::snapshot(&state.db)?),
        "hosts.setSource" | "hosts.removeSource" | "hosts.sourcesSnapshot" => {
            crate::plugins::host_sources::call(context, method, params)
        }
        "hostList.setColumn" | "hostList.removeColumn" => {
            crate::plugins::host_columns::call(context, method, params)
        }
        "hosts.getFields" | "hosts.setFields" => {
            crate::plugins::host_fields::call(context, method, params)
        }
        "hosts.create" => {
            encode(crate::services::hosts::service(app, &state).create(field(&params, "input")?)?)
        }
        "hosts.update" => encode(
            crate::services::hosts::service(app, &state)
                .update(&field::<String>(&params, "id")?, field(&params, "input")?)?,
        ),
        "hosts.delete" => {
            crate::services::hosts::service(app, &state)
                .delete(&field::<String>(&params, "id")?)?;
            Ok(Value::Null)
        }
        "hosts.markUsed" => {
            crate::services::hosts::service(app, &state)
                .mark_used(&field::<String>(&params, "id")?)?;
            Ok(Value::Null)
        }
        "hosts.reorder" => {
            crate::services::hosts::service(app, &state)
                .reorder(&field::<Vec<String>>(&params, "ids")?)?;
            Ok(Value::Null)
        }
        "groups.create" => encode(
            crate::services::hosts::service(app, &state).create_group(field(&params, "input")?)?,
        ),
        "groups.update" => encode(
            crate::services::hosts::service(app, &state)
                .update_group(&field::<String>(&params, "id")?, field(&params, "input")?)?,
        ),
        "groups.delete" => {
            crate::services::hosts::service(app, &state)
                .delete_group(&field::<String>(&params, "id")?)?;
            Ok(Value::Null)
        }
        "hostList.setDecorations" | "hostList.removeDecorations" => {
            crate::plugins::host_list::call(context, method, params)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
