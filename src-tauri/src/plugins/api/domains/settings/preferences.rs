//! Versioned preference RPC adapter. Authorization surrounds the shared writer.
use crate::{
    error::{AppError, AppResult},
    plugins::api::{authorize, encode, HostContext},
    state::AppState,
};
use serde_json::Value;
use tauri::Manager;

pub(super) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    use crate::services::settings::{preferences, read, write};
    match method {
        "preferences.observe" => {
            let request: preferences::contracts::Observe = serde_json::from_value(params)
                .map_err(|_| AppError::validation("plugin.api.invalid:params"))?;
            let worker = context.clone();
            encode(
                read::observe(&context.app, request, move || {
                    authorize(&worker, &["settings.read"])
                })
                .await?,
            )
        }
        "preferences.schema" | "preferences.snapshot" => {
            if params.as_object().is_none_or(|fields| !fields.is_empty()) {
                return Err(AppError::validation("plugin.api.invalid:params"));
            }
            if method == "preferences.schema" {
                return encode(preferences::describe());
            }
            let worker = context.clone();
            encode(
                read::snapshot(&context.app, move || authorize(&worker, &["settings.read"]))
                    .await?,
            )
        }
        "preferences.update" => {
            let request: preferences::contracts::Update = serde_json::from_value(params)
                .map_err(|_| AppError::validation("plugin.api.invalid:params"))?;
            let worker = context.clone();
            write(&context.app, move |writer| {
                let state = worker.app.state::<AppState>();
                authorize(&worker, &["settings.write"])?;
                let prepared = writer.prepare_preferences(request)?;
                let lease = crate::plugins::security::Lease {
                    id: worker.id.clone(),
                    fingerprint: worker.fingerprint.clone(),
                    permissions: worker.permissions.clone(),
                    generation: worker.generation,
                };
                let cancellation = prepared.cancellation();
                let prepared = std::cell::RefCell::new(prepared);
                state.plugins.security.with_authorized_database_then(
                    &state.db,
                    &lease,
                    &["settings.write"],
                    || cancellation.check(),
                    |conn| prepared.borrow().persist_on(conn),
                    |revision| {
                        prepared.borrow_mut().committed_revision(revision);
                        Ok(())
                    },
                )?;
                encode(prepared.into_inner().finish_preferences()?)
            })
            .await
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
