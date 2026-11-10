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
    match method {
        "settings.get" => encode(commands::settings_get(state)),
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
            encode(commands::settings_update(app.clone(), state, patch)?)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
