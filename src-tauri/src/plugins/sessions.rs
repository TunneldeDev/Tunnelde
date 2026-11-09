//! SSH connections created by plugins have the lifetime of their runtime lease.
use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::{api::HostContext, resources::Scope, security::Lease};
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
