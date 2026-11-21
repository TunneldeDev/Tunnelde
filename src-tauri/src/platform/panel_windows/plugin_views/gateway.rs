//! Closed native IPC, not an arbitrary application-command relay. The browser
//! cannot choose a caller label, share activation secrets, or promote itself.
use super::{origin, Ownership, Target};
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
    DescribePreviewProvider {
        target: Target,
    },
    OpenPreviewProvider {
        target: Target,
        plugin_id: String,
        runtime_id: String,
        view_id: String,
        selection_revision: u64,
        source_kind: String,
    },
    SubmitPreviewProviderAction {
        token: String,
        lease: super::super::ownership::Lease,
        id: String,
        attempt_id: String,
        revision: String,
        command: super::super::actions::PreviewCommand,
    },
    Forwarding {
        token: String,
        lease: super::super::ownership::Lease,
        request: super::super::forwarding::request::Request,
    },
    DescribeHostsProvider {
        target: Target,
    },
    OpenHostsProvider {
        target: Target,
        plugin_id: String,
        runtime_id: String,
        view_id: String,
        selection_revision: u64,
    },
    DescribePreferencesProvider {
        target: Target,
    },
    OpenPreferencesProvider {
        target: Target,
        plugin_id: String,
        runtime_id: String,
        view_id: String,
        selection_revision: u64,
    },
    DescribeTasksProvider {
        target: Target,
    },
    OpenTasksProvider {
        target: Target,
        plugin_id: String,
        runtime_id: String,
        view_id: String,
        selection_revision: u64,
    },
    SubmitTasksProviderAction {
        token: String,
        lease: super::super::ownership::Lease,
        key: String,
        ticket: String,
        action_id: String,
    },
    DescribeForwardingProvider {
        target: Target,
    },
    OpenForwardingProvider {
        target: Target,
        host_id: String,
        plugin_id: String,
        runtime_id: String,
        view_id: String,
        selection_revision: u64,
    },
    UnregisterAdapter {
        panel_id: String,
        runtime_id: String,
        generation: u64,
        revision: String,
    },
    RegisterAdapter {
        plugin_id: String,
        runtime_id: String,
        view_id: String,
    },
    Open {
        target: Target,
        plugin_id: String,
        runtime_id: String,
        view_id: String,
    },
    ListUi {},
    ReplyUi {
        id: String,
        result: Value,
        error: Option<String>,
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
    app: &AppHandle,
    ownership: &Ownership,
    window: &str,
    document: &str,
    token: &str,
) -> AppResult<crate::plugins::security::Lease> {
    ownership.native_provider_current(app, window, document, token)?;
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
    if prune(app) {
        native::changed(app);
    }
    let registry = app.state::<native::Registry>();
    // Registered native identity still isn't authority over another view.
    native::lock(&registry)
        .authorize(window.label(), &document)
        .map_err(native::invalid)?;
    match request {
        Request::DescribePreviewProvider { target } => {
            super::preview_provider::describe(app, window.label(), &document, target).await
        }
        Request::OpenPreviewProvider {
            target,
            plugin_id,
            runtime_id,
            view_id,
            selection_revision,
            source_kind,
        } => {
            super::preview_provider::open(
                app,
                (window.label(), &document),
                target,
                super::preview_provider::Selection {
                    plugin: plugin_id,
                    runtime: runtime_id,
                    view: view_id,
                    revision: selection_revision,
                    source_kind,
                },
            )
            .await
        }
        Request::SubmitPreviewProviderAction {
            token,
            lease,
            id,
            attempt_id,
            revision,
            command,
        } => {
            let id = super::preview_provider::submit(
                app,
                (window.label(), &document),
                &lease,
                &token,
                super::super::actions::ViewAction::Preview {
                    id,
                    attempt_id,
                    revision,
                    command,
                },
            )?;
            native::changed(app);
            Ok(json!(id))
        }
        Request::Forwarding {
            token,
            lease,
            request,
        } => {
            super::super::forwarding::provider::request(
                app.clone(),
                window.label(),
                document,
                lease,
                token,
                request,
            )
            .await
        }
        Request::DescribeHostsProvider { target } => {
            super::host_provider::describe(app, window.label(), &document, target).await
        }
        Request::OpenHostsProvider {
            target,
            plugin_id,
            runtime_id,
            view_id,
            selection_revision,
        } => {
            super::host_provider::open(
                app,
                (window.label(), &document),
                target,
                plugin_id,
                runtime_id,
                view_id,
                selection_revision,
            )
            .await
        }
        Request::DescribePreferencesProvider { target } => {
            super::preferences_provider::describe(app, window.label(), &document, target).await
        }
        Request::OpenPreferencesProvider {
            target,
            plugin_id,
            runtime_id,
            view_id,
            selection_revision,
        } => {
            super::preferences_provider::open(
                app,
                (window.label(), &document),
                target,
                plugin_id,
                runtime_id,
                view_id,
                selection_revision,
            )
            .await
        }
        Request::DescribeTasksProvider { target } => {
            super::task_provider::describe(app, window.label(), &document, target).await
        }
        Request::OpenTasksProvider {
            target,
            plugin_id,
            runtime_id,
            view_id,
            selection_revision,
        } => {
            super::task_provider::open(
                app,
                (window.label(), &document),
                target,
                plugin_id,
                runtime_id,
                view_id,
                selection_revision,
            )
            .await
        }
        Request::SubmitTasksProviderAction {
            token,
            lease,
            key,
            ticket,
            action_id,
        } => {
            let id = super::task_provider::submit(
                app,
                (window.label(), &document),
                &lease,
                &token,
                key,
                ticket,
                action_id,
            )?;
            native::changed(app);
            Ok(json!(id))
        }
        Request::DescribeForwardingProvider { target } => {
            super::provider::describe(app, window.label(), &document, target).await
        }
        Request::OpenForwardingProvider {
            target,
            host_id,
            plugin_id,
            runtime_id,
            view_id,
            selection_revision,
        } => {
            super::provider::open(
                app,
                window.label(),
                &document,
                target,
                host_id,
                plugin_id,
                runtime_id,
                view_id,
                selection_revision,
            )
            .await
        }
        Request::UnregisterAdapter {
            panel_id,
            runtime_id,
            generation,
            revision,
        } => {
            let changed = native::lock(&registry)
                .unregister_plugin_adapter(
                    window.label(),
                    &document,
                    &panel_id,
                    &runtime_id,
                    generation,
                    &revision,
                )
                .map_err(native::invalid)?;
            if changed {
                native::changed(app);
            }
            Ok(json!(changed))
        }
        Request::RegisterAdapter {
            plugin_id,
            runtime_id,
            view_id,
        } => {
            // A satellite cannot manufacture an adapter or make other plugins
            // transferable, even if it knows their public contribution IDs.
            native::lock(&registry)
                .main(window.label(), &document)
                .map_err(native::invalid)?;
            let source = tokio::time::timeout(
                std::time::Duration::from_secs(15),
                frontend::source(app, &plugin_id, &runtime_id, &view_id),
            )
            .await
            .map_err(|_| AppError::validation("plugin.timeout"))??;
            let (descriptor, changed) = {
                let mut ownership = native::lock(&registry);
                source.with_current(app, || {
                    ownership
                        .register_plugin_adapter(window.label(), &document, source.clone())
                        .map_err(native::invalid)
                })?
            };
            if changed {
                native::changed(app);
            }
            Ok(json!(descriptor))
        }
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
            ownership
                .admit_plugin_adapter_open(&source)
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
        Request::ListUi {} => {
            let result = native::lock(&registry).view_ui_list(app, window.label(), &document)?;
            Ok(json!(result))
        }
        Request::ReplyUi { id, result, error } => {
            native::lock(&registry).view_ui_reply(
                app,
                window.label(),
                &document,
                &id,
                result,
                error,
            )?;
            native::changed(app);
            Ok(Value::Null)
        }
        Request::PrepareCall { token } => {
            let ownership = native::lock(&registry);
            let owner = current(app, &ownership, window.label(), &document, &token)?;
            Ok(json!(frontend::prepare(app, &token, &owner)?))
        }
        Request::Call {
            token,
            request_id,
            method,
            params,
        } => {
            let policy = frontend::call_policy(&method)
                .ok_or_else(|| AppError::validation("plugin.frontend.nativeMethodUnavailable"))?;
            let (call, id, owner) = {
                let mut ownership = native::lock(&registry);
                let owner = current(app, &ownership, window.label(), &document, &token)?;
                let call = frontend::claim(app, &token, &owner, &request_id, policy)?;
                let (_, id) = frontend::with_owner(app, &token, &owner, || {
                    ownership
                        .native_view_call(window.label(), &document, &token, policy, Instant::now())
                        .map_err(native::invalid)
                })?;
                (call, id, owner)
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
                crate::services::operations::WorkLifetime::new(accepted)
                    .scope(async move {
                        current(
                            &app,
                            &native::lock(&app.state::<native::Registry>()),
                            &label,
                            &document,
                            &token,
                        )?;
                        let origin = origin::Origin::new(
                            app.clone(),
                            label.clone(),
                            document.clone(),
                            token.clone(),
                            owner,
                        );
                        let result = origin::scope(origin, call.run(&app, &method, params)).await?;
                        current(
                            &app,
                            &native::lock(&app.state::<native::Registry>()),
                            &label,
                            &document,
                            &token,
                        )?;
                        Ok(result)
                    })
                    .await
            })
            .await
            .map_err(|_| AppError::internal("plugin.frontend.nativeCallFailed"))?
        }
        Request::CancelCall { token, request_id } => {
            let ownership = native::lock(&registry);
            // Cleanup is tied to the exact issuing document too. Token theft
            // must not allow another window to cancel this view's requests.
            current(app, &ownership, window.label(), &document, &token)?;
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
pub(crate) fn prune(app: &AppHandle) -> bool {
    let (tokens, changed) = {
        let registry = app.state::<native::Registry>();
        let mut ownership = native::lock(&registry);
        let changed =
            ownership.retire_plugin_adapters(|source| source.with_current(app, || Ok(())).is_err());
        let tokens = ownership.prune_native_views(Instant::now(), |token, owner, provider| {
            provider.is_none_or(|binding| binding.check(app).is_ok())
                && frontend::with_owner(app, token, owner, || Ok(())).is_ok()
        });
        ownership.prune_view_ui(app);
        let changed = changed || !tokens.is_empty();
        (tokens, changed)
    };
    frontend::close(app, tokens);
    changed
}
pub(crate) fn retire(app: &AppHandle, plugin: &str, before: u64) {
    let (tokens, changed) = {
        let registry = app.state::<native::Registry>();
        let mut ownership = native::lock(&registry);
        let changed = ownership.retire_plugin_adapters(|source| {
            source.lease.id == plugin && source.lease.generation < before
        });
        (ownership.retire_native_views(plugin, before), changed)
    };
    frontend::close(app, tokens);
    if changed {
        native::changed(app);
    }
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
    current(app, &ownership, window, document, token).ok()?;
    Some(read())
}
