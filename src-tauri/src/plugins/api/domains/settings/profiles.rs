//! Read-only profile metadata adapter, separate from preference values and native dialogs.
use crate::{
    error::{AppError, AppResult},
    plugins::api::{authorize, encode, HostContext},
    settings_profiles::observation,
    state::AppState,
};
use serde_json::Value;
use tauri::Manager;

pub(super) fn dispatch(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    if method != "profiles.observe" {
        return Err(AppError::validation("plugin.api.unknownMethod"));
    }
    let request: observation::contracts::Observe = serde_json::from_value(params)
        .map_err(|_| AppError::validation("plugin.api.invalid:params"))?;
    authorize(context, &["settings.read"])?;
    let state = context.app.state::<AppState>();
    let response = state.db.with(|conn| observation::observe(conn, request))?;
    authorize(context, &["settings.read"])?;
    encode(response)
}
