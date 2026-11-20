//! Origin-window UI queue. Events contain invalidation only; prompt text and
//! reply capabilities are fetched by the exact native document, never broadcast.
use super::{origin::Origin, Ownership};
use crate::{
    error::{AppError, AppResult},
    platform::panel_windows::{native, ownership::Lease as PanelLease},
    plugins::{
        api::HostContext, current_invocation_fence, frontend::native as frontend, security::Lease,
        InvocationFence,
    },
};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, time::Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

#[derive(Clone, Serialize)]
#[serde(tag = "method", rename_all_fields = "camelCase")]
pub(crate) enum Content {
    #[serde(rename = "ui.confirm")]
    Confirm { message: String },
    // Host-internal route only: not a public RPC method or plugin-controlled
    // ui.confirm option. It always renders destructive/default-cancel UX.
    #[serde(rename = "__mounts.forceUnmount")]
    ForceUnmount { message: String },
    #[serde(rename = "ui.showMessage")]
    Message { message: String, kind: String },
}
impl Content {
    fn parse(method: &str, params: &Value) -> AppResult<Self> {
        if !matches!(
            method,
            "ui.confirm" | "ui.showMessage" | "__mounts.forceUnmount"
        ) {
            return Err(AppError::validation(
                "plugin.frontend.nativeMethodUnavailable",
            ));
        }
        let invalid = || AppError::validation("plugin.api.frontend:invalid:message");
        let message = params
            .get("message")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let limit = if method != "ui.showMessage" {
            220 * 1024
        } else {
            4000
        };
        if message.is_empty() || message.contains('\0') || message.encode_utf16().count() > limit {
            return Err(invalid());
        }
        match method {
            "ui.confirm" => Ok(Self::Confirm {
                message: message.into(),
            }),
            "__mounts.forceUnmount" => Ok(Self::ForceUnmount {
                message: message.into(),
            }),
            "ui.showMessage" => {
                let kind = match params.get("kind") {
                    None | Some(Value::Null) => "info",
                    Some(Value::String(kind))
                        if matches!(kind.as_str(), "info" | "success" | "error") =>
                    {
                        kind
                    }
                    _ => return Err(AppError::validation("plugin.api.frontend:invalid:kind")),
                };
                Ok(Self::Message {
                    message: message.into(),
                    kind: kind.into(),
                })
            }
            _ => Err(AppError::validation(
                "plugin.frontend.nativeMethodUnavailable",
            )),
        }
    }
    fn confirm(&self) -> bool {
        matches!(self, Self::Confirm { .. } | Self::ForceUnmount { .. })
    }
    fn response(&self, value: Value, error: Option<String>) -> AppResult<Value> {
        if let Some(error) = error {
            return Err(AppError::validation(format!(
                "plugin.api.frontend:{}",
                error.chars().take(512).collect::<String>()
            )));
        }
        if (self.confirm() && value.is_boolean()) || (!self.confirm() && value.is_null()) {
            Ok(value)
        } else {
            Err(AppError::validation("plugin.api.frontend:invalid:result"))
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Prompt {
    id: String,
    plugin_id: String,
    #[serde(flatten)]
    content: Content,
}
pub(super) struct Pending {
    window: String,
    document: String,
    token: String,
    owner: Lease,
    permissions: &'static [&'static str],
    invocation: Option<InvocationFence>,
    panel: PanelLease,
    interaction: String,
    content: Content,
    sender: Option<oneshot::Sender<AppResult<Value>>>,
}
#[derive(Default)]
pub(super) struct Queue(HashMap<String, Pending>);
impl Queue {
    pub(super) fn has_modal(&self, window: &str) -> bool {
        self.0
            .values()
            .any(|pending| pending.window == window && pending.content.confirm())
    }
}
impl Ownership {
    pub(in crate::platform::panel_windows) fn origin_picker_pending(&self, window: &str) -> bool {
        #[cfg(not(windows))]
        {
            self.native_views.pickers.has_window(window)
        }
        #[cfg(windows)]
        {
            let _ = window;
            false
        }
    }
    fn begin_view_ui(
        &mut self,
        origin: &Origin,
        permissions: &'static [&'static str],
        content: Content,
        sender: oneshot::Sender<AppResult<Value>>,
    ) -> AppResult<String> {
        origin.authorize(self)?;
        if self.native_views.ui.0.len() >= 64
            || self
                .native_views
                .ui
                .0
                .values()
                .filter(|p| p.owner.id == origin.plugin.id)
                .count()
                >= 8
        {
            return Err(AppError::validation("plugin.api.busy"));
        }
        if content.confirm()
            && (self.native_views.ui.has_modal(&origin.window)
                || self.origin_picker_pending(&origin.window))
        {
            return Err(AppError::validation("plugin.api.frontend:dialog.busy"));
        }
        let panel = self
            .native_view_owned_lease(
                &origin.window,
                &origin.document,
                &origin.token,
                Instant::now(),
            )
            .map_err(native::invalid)?;
        let interaction = self
            .begin_interaction(&origin.window, &origin.document, &panel)
            .map_err(native::invalid)?;
        let id = uuid::Uuid::new_v4().to_string();
        self.native_views.ui.0.insert(
            id.clone(),
            Pending {
                window: origin.window.clone(),
                document: origin.document.clone(),
                token: origin.token.clone(),
                owner: origin.plugin.clone(),
                permissions,
                invocation: current_invocation_fence(),
                panel,
                interaction,
                content,
                sender: Some(sender),
            },
        );
        Ok(id)
    }
    fn remove_view_ui(&mut self, id: &str) -> Option<Pending> {
        let pending = self.native_views.ui.0.remove(id)?;
        let _ = self.end_interaction(
            &pending.window,
            &pending.document,
            &pending.panel,
            &pending.interaction,
        );
        Some(pending)
    }
    pub(super) fn prune_view_ui(&mut self, app: &AppHandle) {
        let expired: Vec<_> = self
            .native_views
            .ui
            .0
            .iter()
            .filter(|(_, p)| self.with_view_ui(app, p, || Ok(())).is_err())
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if let Some(pending) = self.remove_view_ui(&id) {
                if let Some(sender) = pending.sender {
                    let _ = sender.send(Err(AppError::validation("plugin.frontend.expired")));
                }
            }
        }
    }
    fn with_view_ui<T>(
        &self,
        app: &AppHandle,
        pending: &Pending,
        deliver: impl FnOnce() -> AppResult<T>,
    ) -> AppResult<T> {
        self.native_provider_current(app, &pending.window, &pending.document, &pending.token)?;
        let owner = self
            .native_view_resource(
                &pending.window,
                &pending.document,
                &pending.token,
                Instant::now(),
            )
            .map_err(native::invalid)?;
        if owner != pending.owner {
            return Err(AppError::validation("plugin.frontend.expired"));
        }
        frontend::with_owner_permissions(app, &pending.token, &owner, pending.permissions, || {
            if let Some(fence) = &pending.invocation {
                fence.with_live(deliver)
            } else {
                deliver()
            }
        })
    }

    pub(super) fn view_ui_list(
        &mut self,
        app: &AppHandle,
        window: &str,
        document: &str,
    ) -> AppResult<Vec<Prompt>> {
        self.authorize(window, document).map_err(native::invalid)?;
        self.prune_view_ui(app);
        Ok(self
            .native_views
            .ui
            .0
            .iter()
            .filter(|(_, p)| p.window == window && p.document == document)
            .map(|(id, p)| Prompt {
                id: id.clone(),
                plugin_id: p.owner.id.clone(),
                content: p.content.clone(),
            })
            .collect())
    }
    pub(super) fn view_ui_reply(
        &mut self,
        app: &AppHandle,
        window: &str,
        document: &str,
        id: &str,
        value: Value,
        error: Option<String>,
    ) -> AppResult<()> {
        self.authorize(window, document).map_err(native::invalid)?;
        self.native_views
            .ui
            .0
            .get(id)
            .filter(|p| p.window == window && p.document == document)
            .ok_or_else(|| AppError::validation("plugin.api.requestExpired"))?;
        // Remove only after exact caller validation. Ownership stays locked,
        // and delivery itself is linearized against policy / invocation cancel.
        let mut pending = self
            .remove_view_ui(id)
            .ok_or_else(|| AppError::validation("plugin.api.requestExpired"))?;
        let mut sender = pending.sender.take();
        let accepted = self.with_view_ui(app, &pending, || {
            let result = pending.content.response(value, error);
            if let Some(sender) = sender.take() {
                let _ = sender.send(result);
            }
            Ok(())
        });
        if let Err(error) = accepted {
            let error = std::sync::Arc::new(error);
            if let Some(sender) = sender {
                let _ = sender.send(Err(AppError::Shared(error.clone())));
            }
            return Err(AppError::Shared(error));
        }
        Ok(())
    }
}
struct Guard {
    app: AppHandle,
    id: String,
}
impl Drop for Guard {
    fn drop(&mut self) {
        native::lock(&self.app.state::<native::Registry>()).remove_view_ui(&self.id);
        native::changed(&self.app);
    }
}
pub(crate) async fn request(
    origin: Origin,
    context: &HostContext,
    method: &str,
    params: Value,
    permissions: &'static [&'static str],
) -> AppResult<Value> {
    let content = Content::parse(method, &params)?;
    let confirmation = content.confirm();
    let (sender, receiver) = oneshot::channel();
    let id = {
        let registry = context.app.state::<native::Registry>();
        let mut ownership = native::lock(&registry);
        origin.authorize(&ownership)?;
        frontend::with_owner_permissions(
            &context.app,
            &origin.token,
            &origin.plugin,
            permissions,
            || {
                let enqueue = || ownership.begin_view_ui(&origin, permissions, content, sender);
                if let Some(fence) = current_invocation_fence() {
                    fence.with_live(enqueue)
                } else {
                    enqueue()
                }
            },
        )?
    };
    let _guard = Guard {
        app: context.app.clone(),
        id,
    };
    native::changed(&context.app);
    let fence = current_invocation_fence();
    let cancelled = async {
        if let Some(fence) = fence {
            fence.cancelled().await
        } else {
            std::future::pending().await
        }
    };
    let state = context.app.state::<crate::state::AppState>();
    state.plugins.security.guard(&origin.plugin, async {
        tokio::select! {
            biased;
            () = cancelled => Err(AppError::validation("plugin.api.cancelled")),
            _ = tokio::time::sleep(std::time::Duration::from_secs(if confirmation {55} else {15})) => {
                if confirmation { Ok(Value::Bool(false)) } else { Err(AppError::validation("plugin.api.frontendTimeout")) }
            },
            result = receiver => result.map_err(|_| AppError::validation("plugin.api.frontendClosed"))?,
        }
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_ui_method_message_and_utf16_limits_are_exact() {
        for message in ["", "bad\0text"] {
            assert!(Content::parse("ui.confirm", &json!({"message":message})).is_err());
        }
        assert!(Content::parse("ui.confirm", &json!({"message":"a".repeat(220 * 1024)})).is_ok());
        assert!(
            Content::parse("ui.confirm", &json!({"message":"a".repeat(220 * 1024 + 1)})).is_err()
        );
        assert!(Content::parse("ui.showMessage", &json!({"message":"😀".repeat(2000)})).is_ok());
        assert!(Content::parse("ui.showMessage", &json!({"message":"😀".repeat(2001)})).is_err());
        assert!(Content::parse("ui.confirm.extra", &json!({"message":"ok"})).is_err());
        for value in [json!(null), json!({}), json!({"message":123})] {
            assert!(Content::parse("ui.confirm", &value).is_err());
        }
    }

    #[test]
    fn native_ui_message_kinds_and_reply_shapes_are_closed() {
        for kind in [json!(null), json!("info"), json!("success"), json!("error")] {
            assert!(Content::parse("ui.showMessage", &json!({"message":"ok","kind":kind})).is_ok());
        }
        for kind in [json!("warning"), json!(false), json!({})] {
            assert!(
                Content::parse("ui.showMessage", &json!({"message":"ok","kind":kind})).is_err()
            );
        }
        let confirm = Content::parse("ui.confirm", &json!({"message":"Confirm"})).unwrap();
        assert_eq!(confirm.response(json!(false), None).unwrap(), json!(false));
        assert!(confirm.response(Value::Null, None).is_err());
        assert!(confirm
            .response(json!(true), Some("dialog.busy".into()))
            .is_err());
        let message = Content::parse("ui.showMessage", &json!({"message":"Done"})).unwrap();
        assert!(message.response(Value::Null, None).is_ok());
        assert!(message.response(json!(true), None).is_err());
    }

    #[test]
    fn native_ui_prompt_serializes_display_only_not_ownership_capabilities() {
        let prompt = Prompt {
            id: "prompt-id".into(),
            plugin_id: "sample".into(),
            content: Content::Confirm {
                message: "Question".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(prompt).unwrap(),
            json!({
                "id":"prompt-id", "pluginId":"sample", "method":"ui.confirm", "message":"Question"
            })
        );
    }
    #[test]
    fn force_unmount_is_a_private_host_variant_and_requires_a_boolean_answer() {
        let content =
            Content::parse("__mounts.forceUnmount", &json!({"message":"Force?"})).unwrap();
        assert!(content.confirm());
        assert!(matches!(content, Content::ForceUnmount { .. }));
        assert_eq!(
            serde_json::to_value(&content).unwrap(),
            json!({"method":"__mounts.forceUnmount","message":"Force?"})
        );
        for answer in [true, false] {
            assert_eq!(
                content.response(json!(answer), None).unwrap(),
                json!(answer)
            );
        }
        for invalid in [Value::Null, json!("true"), json!({"confirmed":true})] {
            assert!(content.response(invalid, None).is_err());
        }
        assert!(content
            .response(json!(true), Some("dialog.busy".into()))
            .is_err());
        assert!(crate::plugins::api::method_info("__mounts.forceUnmount").is_none());
        let public = Content::parse(
            "ui.confirm",
            &json!({"message":"Ordinary", "method":"__mounts.forceUnmount", "danger":true}),
        )
        .unwrap();
        assert!(matches!(public, Content::Confirm { .. }));
        assert!(
            Content::parse("__mounts.forceUnmount.extra", &json!({"message":"Force?"})).is_err()
        );
    }
}
