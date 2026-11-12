use crate::error::{AppError, AppResult};
use crate::plugins::api::{authorize, field, optional, HostContext};
use serde_json::{json, Value};
use std::path::Path;
use tauri::Emitter;

const MAX_TEXT: usize = 512 * 1024;

fn validate_text(bytes: &[u8]) -> AppResult<()> {
    if bytes.len() > MAX_TEXT {
        return Err(AppError::validation("plugin.api.fileTooLarge"));
    }
    if bytes.contains(&0) || std::str::from_utf8(bytes).is_err() {
        return Err(AppError::validation("plugin.api.invalidText"));
    }
    Ok(())
}

pub(in crate::plugins::api) async fn local_read(path: String) -> AppResult<Value> {
    let (reader, _) = crate::services::files::read::LocalReader::open(path).await?;
    let bytes = reader.prefix(MAX_TEXT).await?;
    validate_text(&bytes)?;
    Ok(
        json!({"size":bytes.len(),"content":String::from_utf8(bytes).map_err(|_| AppError::validation("plugin.api.invalidText"))?}),
    )
}

pub(in crate::plugins) async fn write_local(
    context: &HostContext,
    params: &Value,
    check_scope: impl Fn(&Path, &str) -> AppResult<()> + Send + 'static,
) -> AppResult<Value> {
    let path: String = field(params, "path")?;
    let content: String = field(params, "content")?;
    let baseline: Option<String> = optional(params, "baseline")?;
    validate_text(content.as_bytes())?;
    if let Some(baseline) = &baseline {
        validate_text(baseline.as_bytes())?;
    }
    authorize(context, &["fs.write"])?;
    let app = context.app.clone();
    let context = context.clone();
    crate::ssh::files::local_editor::save_checked(
        context.app.clone(),
        path,
        content,
        baseline,
        move |target, original| {
            // Recheck on the blocking worker after lock acquisition and again
            // immediately before atomic publication, including RPC revocation.
            authorize(&context, &["fs.write"])?;
            if let Some(client) = &context.tool_client {
                crate::plugins::tools::authorize_client(&context, client)?;
            }
            validate_text(original.as_bytes())?;
            check_scope(target, original)
        },
        move || {
            // Direct calls and scoped AI/MCP tools share this publication event.
            // It survives RPC cancellation after the atomic publication gate.
            let _ = app.emit(
                "plugin://domain-changed",
                json!({"domain":"files","sessionId":null}),
            );
        },
    )
    .await?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests;
