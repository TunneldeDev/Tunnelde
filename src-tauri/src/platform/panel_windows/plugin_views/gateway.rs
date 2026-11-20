//! Closed native IPC, not an arbitrary application-command relay. The browser
//! cannot choose a caller label, share activation secrets, or promote itself.
use super::{Ownership, Target};
use crate::{
    error::{AppError, AppResult},
    platform::panel_windows::native,
    plugins::frontend::native as frontend,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Instant;
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Open {
        target: Target,
        plugin_id: String,
        runtime_id: String,
        view_id: String,
    },
    PrepareCall {
        token: String,
    },
    Call {
        token: String,
        request_id: String,
        method: String,
        params: Value,
    },
    CancelCall {
        token: String,
        request_id: String,
    },
    Close {
        token: String,
    },
}
struct AcceptedCall {
    app: AppHandle,
    id: String,
}
impl Drop for AcceptedCall {
    fn drop(&mut self) {
        native::lock(&self.app.state::<native::Registry>()).settle_native_view_call(&self.id);
        native::changed(&self.app);
    }
}
fn current(
    ownership: &Ownership,
    window: &str,
    document: &str,
    token: &str,
) -> AppResult<crate::plugins::security::Lease> {
    ownership
        .native_view_owner(window, document, token, Instant::now())
        .map_err(native::invalid)
}
#[tauri::command]
pub(crate) async fn panel_window_plugin_view(
    window: WebviewWindow,
    document: String,
    request: Request,
) -> AppResult<Value> {
    let app = window.app_handle();
    prune(app);
    let registry = app.state::<native::Registry>();
    // Registered native identity still isn't authority over another view.
    native::lock(&registry)
        .authorize(window.label(), &document)
        .map_err(native::invalid)?;
    match request {
        Request::Open {
            target,
            plugin_id,
            runtime_id,
            view_id,
        } => {
            native::lock(&registry)
                .native_view_target(
                    window.label(),
                    &document,
                    &target,
                    &plugin_id,
                    &view_id,
                    Instant::now(),
                )
                .map_err(native::invalid)?;
            let source = tokio::time::timeout(
                std::time::Duration::from_secs(15),
                frontend::source(app, &plugin_id, &runtime_id, &view_id),
            )
            .await
            .map_err(|_| AppError::validation("plugin.timeout"))??;
            let mut ownership = native::lock(&registry);
            ownership
                .native_view_target(
                    window.label(),
                    &document,
                    &target,
                    &plugin_id,
                    &view_id,
                    Instant::now(),
                )
                .map_err(native::invalid)?;
            let owner = source.lease.clone();
            let session = frontend::open(app, source)?;
            if let Err(error) = ownership.bind_native_view(
                (window.label(), &document),
                target,
                owner,
                &view_id,
                session.token.clone(),
                Instant::now(),
            ) {
                frontend::close(app, vec![session.token]);
                return Err(native::invalid(error));
            }
            Ok(json!(session))
        }
        Request::PrepareCall { token } => {
            let ownership = native::lock(&registry);
            let owner = current(&ownership, window.label(), &document, &token)?;
            Ok(json!(frontend::prepare(app, &token, &owner)?))
        }
        Request::Call {
            token,
            request_id,
            method,
            params,
        } => {
            // This tranche exposes only the two reviewed metadata methods.
            // Keep nativeWindows discovery false until real renderer/domain
            // parity is wired; do not grant RPCs based on namespace heuristics.
            if !frontend::metadata_method(&method) {
                return Err(AppError::validation(
                    "plugin.frontend.nativeMethodUnavailable",
                ));
            }
            let (call, id) = {
                let mut ownership = native::lock(&registry);
                let owner = current(&ownership, window.label(), &document, &token)?;
                let call = frontend::claim(app, &token, &owner, &request_id)?;
                let (_, id) = frontend::with_owner(app, &token, &owner, || {
                    ownership
                        .native_view_call(window.label(), &document, &token, true, Instant::now())
                        .map_err(native::invalid)
                })?;
                (call, id)
            };
            let accepted = AcceptedCall {
                app: app.clone(),
                id,
            };
            let app = app.clone();
            let label = window.label().to_owned();
            // IPC/request cancellation cannot drop an admitted native worker.
            // The fence lives INSIDE it until actual settlement, even if the
            // originating document disappears or its caller stops waiting.
            tauri::async_runtime::spawn(async move {
                let _accepted = accepted;
                current(
                    &native::lock(&app.state::<native::Registry>()),
                    &label,
                    &document,
                    &token,
                )?;
                let result = call.run(&app, &method, params).await?;
                current(
                    &native::lock(&app.state::<native::Registry>()),
                    &label,
                    &document,
                    &token,
                )?;
                Ok(result)
            })
            .await
            .map_err(|_| AppError::internal("plugin.frontend.nativeCallFailed"))?
        }
        Request::CancelCall { token, request_id } => {
            let ownership = native::lock(&registry);
            // Cleanup is tied to the exact issuing document too. Token theft
            // must not allow another window to cancel this view's requests.
            current(&ownership, window.label(), &document, &token)?;
            Ok(json!(frontend::cancel(app, &token, &request_id)))
        }
        Request::Close { token } => {
            if native::lock(&registry)
                .close_native_view(window.label(), &document, &token)
                .map_err(native::invalid)?
            {
                frontend::close(app, vec![token]);
            }
            Ok(Value::Null)
        }
    }
}
pub(crate) fn prune(app: &AppHandle) {
    let tokens = native::lock(&app.state::<native::Registry>())
        .prune_native_views(Instant::now(), |token, owner| {
            frontend::with_owner(app, token, owner, || Ok(())).is_ok()
        });
    frontend::close(app, tokens);
}
pub(crate) fn retire(app: &AppHandle, plugin: &str, before: u64) {
    let tokens = native::lock(&app.state::<native::Registry>()).retire_native_views(plugin, before);
    frontend::close(app, tokens);
}

/// Synchronous immutable module reads share the ownership transaction with
/// document reload and handoff. The native protocol supplies the caller label.
pub(crate) fn read_asset<T>(
    app: &AppHandle,
    window: &str,
    token: &str,
    read: impl FnOnce() -> T,
) -> Option<T> {
    let registry = app.state::<native::Registry>();
    let ownership = native::lock(&registry);
    let document = ownership.document(window)?;
    current(&ownership, window, document, token).ok()?;
    Some(read())
}
