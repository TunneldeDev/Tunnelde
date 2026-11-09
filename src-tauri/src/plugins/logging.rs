//! Plugin logging wire adapter. Authorization remains in the common dispatcher.
use serde_json::Value;

use crate::diagnostics::{LogEntry, LogOrigin};
use crate::error::{AppError, AppResult};

pub(super) fn write(id: &str, generation: u64, params: Value) -> AppResult<Value> {
    super::api::validate_params(&params)?;
    let entry: LogEntry = serde_json::from_value(params)
        .map_err(|_| AppError::validation("plugin.api.invalid:log"))?;
    crate::diagnostics::write(LogOrigin::Plugin { id, generation }, entry)?;
    Ok(Value::Null)
}

#[cfg(test)]
pub(super) mod tests;
