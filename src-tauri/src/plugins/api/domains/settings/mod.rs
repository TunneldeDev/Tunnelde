use crate::plugins::api::{authorize, encode, field, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::Value;
use tauri::Manager;
mod preferences;
mod profiles;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    if method.starts_with("profiles.") {
        return profiles::dispatch(context, method, params).await;
    }
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
            // Persisting file contents requires a local user choice, including
            // for legacy settings writers outside the versioned allowlist.
            if patch.get("editorDraftRecovery").is_some() {
                return Err(AppError::validation("editor.recoveryConsentRequired"));
            }
            let worker = context.clone();
            crate::services::settings::write(app, move |writer| {
                let state = worker.app.state::<AppState>();
                authorize(&worker, &["settings.write"])?;
                let mut prepared = writer.prepare_update(patch)?;
                let lease = crate::plugins::security::Lease {
                    id: worker.id.clone(),
                    fingerprint: worker.fingerprint.clone(),
                    permissions: worker.permissions.clone(),
                    generation: worker.generation,
                };
                // Waiting for a concurrent commit is an authorization boundary too.
                state
                    .plugins
                    .security
                    .with_authorized(&lease, &["settings.write"], || prepared.persist())?;
                encode(prepared.finish())
            })
            .await
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
