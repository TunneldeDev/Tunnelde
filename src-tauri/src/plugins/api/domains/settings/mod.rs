use crate::plugins::api::{authorize, encode, field, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::Value;
use tauri::Manager;
mod preferences;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    if method.starts_with("preferences.") {
        return preferences::dispatch(context, method, params).await;
    }
    let app = &context.app;
    let state = app.state::<AppState>();
    match method {
        "settings.get" => encode(crate::services::settings::read(&state)),
        "settings.update" => {
            let patch: Value = field(&params, "patch")?;
            if !patch.is_object() {
                return Err(AppError::validation("plugin.api.invalid:patch"));
            }
            if patch.get("uiProviders").is_some() {
                return Err(AppError::validation(
                    "plugin.frontend.userSelectionRequired",
                ));
            }
            let writer = crate::services::settings::writer(app, &state).await;
            authorize(context, &["settings.write"])?;
            let mut prepared = writer.prepare_update(patch)?;
            let lease = crate::plugins::security::Lease {
                id: context.id.clone(),
                fingerprint: context.fingerprint.clone(),
                permissions: context.permissions.clone(),
                generation: context.generation,
            };
            // Waiting for a concurrent commit is an authorization boundary too.
            state
                .plugins
                .security
                .with_authorized(&lease, &["settings.write"], || prepared.persist())?;
            encode(prepared.finish())
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
