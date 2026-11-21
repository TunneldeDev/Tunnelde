use crate::plugins::api::{authorize, encode, field, HostContext};
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
        "app.info" => encode(commands::app_info(app.clone(), state)),
        "app.openExternal" => {
            let url = field(&params, "url")?;
            let worker = context.clone();
            let effect = || {
                authorize(&worker, &["app.openExternal"])?;
                commands::open_external(app.clone(), url)
            };
            match crate::platform::panel_windows::plugin_views::origin::current() {
                Some(origin) => origin.with_current(effect)?,
                None => effect()?,
            }
            Ok(Value::Null)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
