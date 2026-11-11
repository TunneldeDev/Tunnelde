mod execution;
use crate::plugins::api::{encode, field, HostContext};
use crate::{
    commands,
    error::{AppError, AppResult},
    state::AppState,
};
use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

// The plugin wire representation is deliberately independent from the SSH
// manager's internal session type. Keep existing fields for API v1 clients.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::plugins::api) struct PluginSession {
    id: String,
    host_id: String,
    title: String,
    address: String,
    cols: u32,
    rows: u32,
    connected_at: i64,
}

impl From<crate::ssh::SessionInfo> for PluginSession {
    fn from(session: crate::ssh::SessionInfo) -> Self {
        Self {
            id: session.id,
            host_id: session.host_id,
            title: session.title,
            address: session.address,
            cols: session.cols,
            rows: session.rows,
            connected_at: session.connected_at,
        }
    }
}

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let app = &context.app;
    let state = app.state::<AppState>();
    match method {
        "sessions.list" => encode(
            commands::ssh_sessions(state)
                .into_iter()
                .map(PluginSession::from)
                .collect::<Vec<_>>(),
        ),
        "sessions.connect" => encode(PluginSession::from(
            crate::plugins::sessions::connect(context, field(&params, "request")?).await?,
        )),
        "sessions.disconnect" => {
            commands::ssh_disconnect(app.clone(), field(&params, "sessionId")?)?;
            Ok(Value::Null)
        }
        "sessions.requestHandoff" => encode(
            crate::plugins::sessions::request_handoff(context, field(&params, "sessionId")?)
                .await?,
        ),
        "sessions.exec" => execution::execute(context, &params).await,
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}

#[cfg(test)]
mod tests;
