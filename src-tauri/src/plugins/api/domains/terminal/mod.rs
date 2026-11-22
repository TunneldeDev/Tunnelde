use crate::plugins::api::{field, HostContext};
use crate::{
    commands,
    error::{AppError, AppResult},
};
use base64::Engine;
use serde_json::Value;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let app = &context.app;
    let check = || {
        if let Some(origin) = crate::platform::panel_windows::plugin_views::origin::current() {
            origin.authorize_call(crate::plugins::frontend::native::CallPolicy::OwnedData)?;
        }
        Ok::<(), AppError>(())
    };
    match method {
        "terminal.write" => {
            check()?;
            let data: String = field(&params, "data")?;
            commands::ssh_write(
                app.clone(),
                field(&params, "sessionId")?,
                base64::engine::general_purpose::STANDARD.encode(data.as_bytes()),
            )?;
            check()?;
            Ok(Value::Null)
        }
        "terminal.resize" => {
            check()?;
            commands::ssh_resize(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "cols")?,
                field(&params, "rows")?,
            )?;
            check()?;
            Ok(Value::Null)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
