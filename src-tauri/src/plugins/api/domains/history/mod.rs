use crate::plugins::api::{encode, field, optional, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use rusqlite::OptionalExtension;
use serde_json::Value;
use tauri::Manager;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let app = &context.app;
    let state = app.state::<AppState>();
    let lease = crate::plugins::security::Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    match method {
        "history.list" => encode(crate::services::history::service(app, &state).list(
            &field::<String>(&params, "hostId")?,
            optional(&params, "limit")?,
        )?),
        "history.record" => {
            let host_id = field::<String>(&params, "hostId")?;
            let command = field::<String>(&params, "command")?;
            let worker = context.clone();
            let event_host = host_id.clone();
            let origin = crate::platform::panel_windows::plugin_views::origin::current();
            state.plugins.security.with_authorized_fenced_database_then(
                &state.db,
                &lease,
                &["history.write"],
                || Ok(()),
                origin
                    .as_ref()
                    .map(|origin| origin as &dyn crate::services::operations::Authority),
                |conn| {
                    crate::db::hosts::find_host(conn, &host_id)?;
                    Ok(crate::db::history::record(conn, &host_id, &command)?)
                },
                move |entry| {
                    if entry.is_some() {
                        crate::services::history::changed(&worker.app, &event_host);
                    }
                    encode(entry.map(crate::services::history::Entry::from))
                },
            )
        }
        "history.delete" => {
            let id = field::<i64>(&params, "id")?;
            let worker = context.clone();
            let origin = crate::platform::panel_windows::plugin_views::origin::current();
            state.plugins.security.with_authorized_fenced_database_then(
                &state.db,
                &lease,
                &["history.write"],
                || Ok(()),
                origin
                    .as_ref()
                    .map(|origin| origin as &dyn crate::services::operations::Authority),
                |conn| {
                    let tx = conn.unchecked_transaction()?;
                    let host_id: Option<String> = tx
                        .query_row(
                            "SELECT host_id FROM command_history WHERE id=?1",
                            [id],
                            |row| row.get(0),
                        )
                        .optional()?;
                    crate::db::history::delete(&tx, id)?;
                    tx.commit()?;
                    Ok(host_id)
                },
                move |host_id| {
                    if let Some(host_id) = host_id {
                        crate::services::history::changed(&worker.app, &host_id);
                    }
                    Ok(Value::Null)
                },
            )
        }
        "history.clear" => {
            let host_id = field::<String>(&params, "hostId")?;
            let worker = context.clone();
            let event_host = host_id.clone();
            let origin = crate::platform::panel_windows::plugin_views::origin::current();
            state.plugins.security.with_authorized_fenced_database_then(
                &state.db,
                &lease,
                &["history.write"],
                || Ok(()),
                origin
                    .as_ref()
                    .map(|origin| origin as &dyn crate::services::operations::Authority),
                |conn| {
                    let tx = conn.unchecked_transaction()?;
                    let changed: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM command_history WHERE host_id=?1)",
                        [&host_id],
                        |row| row.get(0),
                    )?;
                    crate::db::history::clear(&tx, &host_id)?;
                    tx.commit()?;
                    Ok(changed)
                },
                move |changed| {
                    if changed {
                        crate::services::history::changed(&worker.app, &event_host);
                    }
                    Ok(Value::Null)
                },
            )
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
