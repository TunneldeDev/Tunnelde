//! SSH connections created by plugins have the lifetime of their runtime lease.
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use super::{api::HostContext, runtime::ownership::Scope, security::Lease};
use crate::{
    error::{AppError, AppResult},
    ssh::{SessionInfo, SshConnectRequest},
    state::AppState,
};

/// Transient only: the registry stores IDs, never AppHandles that would keep
/// AppState alive through a reference cycle. Drop also handles post-await denial.
struct PendingConnection {
    app: AppHandle,
    session: Option<SessionInfo>,
}

impl Drop for PendingConnection {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            let _ = crate::ssh::disconnect(&self.app, &session.id);
        }
    }
}

pub(super) async fn connect(
    context: &HostContext,
    request: SshConnectRequest,
) -> AppResult<SessionInfo> {
    let state = context.app.state::<AppState>();
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    let reservation = state
        .plugins
        .security
        .with_authorized(&lease, &["ssh.exec"], || {
            super::tools::with_client_authorized(
                &context.id,
                context.generation,
                context.tool_client.as_deref(),
                || {
                    // Background transports observe closure periodically. Admission must
                    // not wait for their polling task to forget an already-dead ID.
                    state.plugins.sessions.forget(|id| !state.ssh.is_active(id));
                    let scope = context
                        .tool_client
                        .as_ref()
                        .map(|client| {
                            context
                                .tool_request
                                .map(|request| Scope {
                                    client: client.clone(),
                                    request,
                                })
                                .ok_or_else(|| AppError::validation("plugin.tools.invalidIdentity"))
                        })
                        .transpose()?;
                    state.plugins.sessions.reserve(lease.clone(), scope)
                },
            )
        })?;
    let mut pending = state
        .plugins
        .security
        .guard(&lease, async {
            let session = tokio::time::timeout(
                Duration::from_secs(120),
                crate::commands::ssh_connect(context.app.clone(), request),
            )
            .await
            .map_err(|_| AppError::Ssh("ssh.timeout".into()))??;
            Ok(PendingConnection {
                app: context.app.clone(),
                session: Some(session),
            })
        })
        .await?;
    let session = pending.session.as_ref().expect("uncommitted connection");
    state
        .plugins
        .security
        .with_authorized(&lease, &["ssh.exec"], || {
            super::tools::with_client_authorized(
                &context.id,
                context.generation,
                context.tool_client.as_deref(),
                || {
                    reservation
                        .commit(session.id.clone())
                        .map_err(|_| AppError::validation("pluginSecurity.changed"))
                },
            )
        })?;
    // A server can close between returning from connect and accepting ownership.
    // Natural closure forgets live IDs; rechecking also covers closure before commit.
    if !state.ssh.is_active(&session.id) {
        return Err(AppError::Ssh("ssh.sessionMissing".into()));
    }
    Ok(pending.session.take().expect("accepted connection"))
}

pub(super) fn remove_runtime(app: &AppHandle, owner: &str, generation: impl Fn(u64) -> bool) {
    let state = app.state::<AppState>();
    let sessions = state.plugins.sessions.remove_runtime(owner, generation);
    for session_id in sessions {
        let _ = crate::ssh::disconnect(app, &session_id);
    }
}

pub(super) fn remove_client(context: &HostContext, client: &str) {
    let state = context.app.state::<AppState>();
    let sessions = state
        .plugins
        .sessions
        .remove_client(&context.id, context.generation, client);
    for id in sessions {
        let _ = crate::ssh::disconnect(&context.app, &id);
    }
}

/// Consent remains owned by the native dialog callback, even if the invoking
/// plugin disappears. One outstanding dialog bounds orphaned/pending prompts.
fn handoff_dialogs() -> &'static Arc<tokio::sync::Semaphore> {
    static DIALOGS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    DIALOGS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
}

async fn confirmation_response(
    receiver: tokio::sync::oneshot::Receiver<bool>,
    deadline: Duration,
) -> AppResult<bool> {
    tokio::time::timeout(deadline, receiver)
        .await
        .map_err(|_| AppError::validation("plugin.sessions.confirmationExpired"))?
        .map_err(|_| AppError::validation("plugin.sessions.confirmationClosed"))
}

fn handoff_authorized<T>(
    context: &HostContext,
    lease: &Lease,
    ownership: &super::runtime::ownership::Ownership,
    operation: impl FnOnce() -> AppResult<T>,
) -> AppResult<T> {
    context
        .app
        .state::<AppState>()
        .plugins
        .security
        .with_authorized(lease, &["ssh.exec"], || {
            super::tools::with_client_authorized(
                &context.id,
                context.generation,
                ownership.scope.as_ref().map(|scope| scope.client.as_str()),
                || {
                    if !ownership.accepted {
                        return Err(AppError::validation("plugin.sessions.resultPending"));
                    }
                    operation()
                },
            )
        })
}

pub(super) async fn request_handoff(context: &HostContext, session_id: String) -> AppResult<bool> {
    if session_id.is_empty() || session_id.len() > 128 || session_id.chars().any(char::is_control) {
        return Err(AppError::validation("plugin.api.invalid:sessionId"));
    }
    let state = context.app.state::<AppState>();
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    let ownership = state
        .plugins
        .sessions
        .ownership(&context.id, context.generation, |id| id == &session_id)
        .ok_or_else(|| AppError::validation("plugin.sessions.notOwned"))?;
    handoff_authorized(context, &lease, &ownership, || Ok(()))?;
    let session = state
        .ssh
        .list()
        .into_iter()
        .find(|session| session.id == session_id)
        .ok_or_else(|| AppError::Ssh("ssh.sessionMissing".into()))?;
    let permit = handoff_dialogs()
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::validation("plugin.sessions.confirmationBusy"))?;
    let chinese = state.locale().starts_with("zh");
    let (title, explanation, yes, no) = if chinese {
        ("保留此连接？", "保留后，此 SSH 连接将由你管理，插件停止、撤权或进入受限模式时仍会保持连接。你可以随时主动断开；退出 Tunnelde 时连接仍会关闭。", "保留连接", "取消")
    } else {
        ("Keep this connection?", "This SSH connection will be managed by you and remain connected when the plugin stops, loses permission or enters restricted mode. You can disconnect it at any time; quitting Tunnelde still closes it.", "Keep connection", "Cancel")
    };
    // Only host-owned identity and bounded display text enter the consent UI.
    let display: String = session
        .title
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    let message = if chinese {
        format!(
            "{explanation}\n\n插件：{}\n主机：{display}\n连接：{session_id}",
            context.id
        )
    } else {
        format!(
            "{explanation}\n\nPlugin: {}\nHost: {display}\nSession: {session_id}",
            context.id
        )
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    context
        .app
        .dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into()))
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
            drop(permit);
        });
    let confirmed = state
        .plugins
        .security
        .guard(
            &lease,
            confirmation_response(receiver, Duration::from_secs(120)),
        )
        .await?;
    if !confirmed {
        return Ok(false);
    }
    handoff_authorized(context, &lease, &ownership, || {
        if !state.ssh.is_active(&session_id) {
            return Err(AppError::Ssh("ssh.sessionMissing".into()));
        }
        state
            .plugins
            .sessions
            .handoff(&context.id, context.generation, &ownership)
            .ok_or_else(|| AppError::validation("plugin.sessions.notOwned"))?;
        Ok(())
    })?;
    tracing::info!(plugin_id=%context.id, generation=context.generation, session_id=%session_id,
        "user accepted plugin SSH connection ownership");
    crate::logs::record(&state.db, "ssh.handoff", Some(&session_id));
    Ok(true)
}

/// Own newly-created connections until the whole tool invocation accepts its
/// result. Cancellation, errors and dropped transport futures dispose them.
pub(super) struct Request {
    context: HostContext,
    request: uuid::Uuid,
    accepted: bool,
}
impl Request {
    pub fn new(context: &HostContext, request: uuid::Uuid) -> Self {
        Self {
            context: context.clone(),
            request,
            accepted: false,
        }
    }
    pub fn accept(&mut self) {
        self.context
            .app
            .state::<AppState>()
            .plugins
            .sessions
            .accept_request(&self.context.id, self.context.generation, self.request);
        self.accepted = true;
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        if !self.accepted {
            let state = self.context.app.state::<AppState>();
            let sessions = state.plugins.sessions.remove_request(
                &self.context.id,
                self.context.generation,
                self.request,
            );
            for id in sessions {
                let _ = crate::ssh::disconnect(&self.context.app, &id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_consent_requires_a_live_timely_response_and_preserves_decline() {
        for decision in [false, true] {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            sender.send(decision).unwrap();
            assert_eq!(
                confirmation_response(receiver, Duration::from_secs(1))
                    .await
                    .unwrap(),
                decision
            );
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        drop(sender);
        assert_eq!(
            confirmation_response(receiver, Duration::from_secs(1))
                .await
                .unwrap_err()
                .to_string(),
            "plugin.sessions.confirmationClosed"
        );
        let (sender, receiver) = tokio::sync::oneshot::channel();
        assert_eq!(
            confirmation_response(receiver, Duration::from_millis(1))
                .await
                .unwrap_err()
                .to_string(),
            "plugin.sessions.confirmationExpired"
        );
        assert!(
            sender.send(true).is_err(),
            "late consent must not have a waiting caller"
        );
    }
}
