use super::storage_key;
use crate::error::{AppError, AppResult};
use crate::plugins::api::{authorize, encode, field, HostContext};
use serde_json::Value;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: &Value,
) -> AppResult<Value> {
    let key = storage_key(params)?;
    let identity = format!("plugin:{}:{}", context.id, key);
    let value: Option<String> = if method == "secrets.set" {
        Some(field(params, "value")?)
    } else {
        None
    };
    if value.as_ref().is_some_and(|value| value.len() > 16 * 1024) {
        return Err(AppError::validation("plugin.api.secretTooLarge"));
    }
    let method = method.to_owned();
    let context = context.clone();
    tokio::task::spawn_blocking(move || {
        authorize(&context, &["secrets"])?;
        match method.as_str() {
            "secrets.get" => encode(crate::vault::load(&identity)?),
            "secrets.set" => {
                crate::vault::save(&identity, value.as_deref().unwrap_or_default())?;
                Ok(Value::Null)
            }
            "secrets.delete" => {
                crate::vault::forget(&identity)?;
                Ok(Value::Null)
            }
            _ => Err(AppError::validation("plugin.api.unknownMethod")),
        }
    })
    .await
    .map_err(|_| AppError::internal("plugin.api.keyringFailed"))?
}
