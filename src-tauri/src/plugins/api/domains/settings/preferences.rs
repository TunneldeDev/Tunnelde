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
    use crate::services::settings::{preferences, writer};
    let state = context.app.state::<AppState>();
    match method {
        "preferences.observe" => {
            let request: preferences::contracts::Observe = serde_json::from_value(params)
                .map_err(|_| AppError::validation("plugin.api.invalid:params"))?;
            let writer = writer(&context.app, &state).await;
            authorize(context, &["settings.read"])?;
            encode(writer.observe_preferences(request)?)
        }
        "preferences.schema" | "preferences.snapshot" => {
            if params.as_object().is_none_or(|fields| !fields.is_empty()) {
                return Err(AppError::validation("plugin.api.invalid:params"));
            }
            if method == "preferences.schema" {
                return encode(preferences::describe());
            }
            let writer = writer(&context.app, &state).await;
            authorize(context, &["settings.read"])?;
            encode(writer.preferences()?)
        }
        "preferences.update" => {
            let request: preferences::contracts::Update = serde_json::from_value(params)
                .map_err(|_| AppError::validation("plugin.api.invalid:params"))?;
            let writer = writer(&context.app, &state).await;
            authorize(context, &["settings.write"])?;
            let mut prepared = writer.prepare_preferences(request)?;
            let lease = crate::plugins::security::Lease {
                id: context.id.clone(),
                fingerprint: context.fingerprint.clone(),
                permissions: context.permissions.clone(),
                generation: context.generation,
            };
            state
                .plugins
                .security
                .with_authorized(&lease, &["settings.write"], || prepared.persist())?;
            encode(prepared.finish_preferences()?)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
