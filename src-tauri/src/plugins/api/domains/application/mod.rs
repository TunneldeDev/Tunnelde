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
            let origin = crate::platform::panel_windows::plugin_views::origin::current();
            let check_origin_origin = origin.clone();
            let check_origin = || {
                if let Some(origin) = &check_origin_origin {
                    origin
                        .authorize_call(crate::plugins::frontend::native::CallPolicy::OwnedData)?;
                }
                Ok::<(), AppError>(())
            };
            check_origin()?;
            let effect = || {
                authorize(&worker, &["app.openExternal"])?;
                check_origin()?;
                commands::open_external(app.clone(), url)
            };
            match origin {
                Some(origin) => origin.with_current(effect)?,
                None => effect()?,
            }
            Ok(Value::Null)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
