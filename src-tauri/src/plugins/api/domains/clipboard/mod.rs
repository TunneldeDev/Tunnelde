use crate::plugins::api::{encode, field, HostContext};
use crate::{
    commands,
    error::{AppError, AppResult},
};
use serde_json::Value;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let app = &context.app;
    match method {
        "clipboard.readText" => encode(commands::clipboard_read_text(app.clone()).await?),
        "clipboard.writeText" => {
            commands::clipboard_write_text(app.clone(), field(&params, "text")?).await?;
            Ok(Value::Null)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
