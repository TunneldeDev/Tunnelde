use crate::plugins::api::{authorize, encode, field, HostContext};
use crate::{
    commands,
    error::{AppError, AppResult},
    services::operations::{Budget, Cancellation, Errors, WorkLifetime},
};
use serde_json::Value;
use std::sync::LazyLock;
use tauri_plugin_clipboard_manager::ClipboardExt;

const WRITE_ERRORS: Errors = Errors {
    domain: "clipboard.write",
    busy: "clipboard.write.busy",
    cancelled: "clipboard.write.cancelled",
    failed: "clipboard.unavailable",
};
static WRITERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, WRITE_ERRORS));

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let app = &context.app;
    match method {
        "clipboard.readText" => encode(commands::clipboard_read_text(app.clone()).await?),
        "clipboard.writeText" => {
            let text = field::<String>(&params, "text")?;
            let worker = context.clone();
            let origin = crate::platform::panel_windows::plugin_views::origin::current();
            let lifetime = WorkLifetime::current();
            WRITERS
                .blocking(move |cancel: &Cancellation| {
                    lifetime.with(|| {
                        cancel.check()?;
                        let effect = || {
                            authorize(&worker, &["clipboard.write"])?;
                            cancel.check()?;
                            worker
                                .app
                                .clipboard()
                                .write_text(text)
                                .map_err(|_| AppError::internal("clipboard.unavailable"))
                        };
                        match origin {
                            Some(origin) => origin.with_current(effect),
                            None => effect(),
                        }
                    })
                })
                .await?;
            Ok(Value::Null)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
