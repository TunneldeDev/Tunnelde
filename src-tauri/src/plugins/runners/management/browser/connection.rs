use super::{
    destination,
    operation::Operation,
    registry::{self, Pending},
};
use crate::{
    error::{AppError, AppResult},
    ssh::{session, SessionInfo, SshConnectRequest},
    state::AppState,
};
use tauri::{AppHandle, Manager};

/// Closes newly created private transports on every error/cancellation boundary.
struct Acquired {
    app: AppHandle,
    session: Option<SessionInfo>,
}
impl Drop for Acquired {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            let _ = session::disconnect(&self.app, &session.id);
        }
    }
}

pub(super) async fn connect(
    app: &AppHandle,
    pending: &Pending,
    mut request: SshConnectRequest,
) -> AppResult<SessionInfo> {
    let (op, target) = Operation::begin(app, pending).await?;
    let expected = destination::identity(&pending.record)?;
    if request.host_id != expected.host_id {
        return Err(AppError::validation("plugin.runners.destinationChanged"));
    }
    // A native recovery browser never opens a terminal or a forwarding connection.
    request.background = true;
    request.purpose = None;
    let mut acquired = registry::guard(pending, async {
        let session = target.connect_bound(app.clone(), request, expected).await?;
        // Arm cleanup in the same poll which produced the private session.
        Ok(Acquired {
            app: app.clone(),
            session: Some(session),
        })
    })
    .await?;
    let observed = registry::guard(pending, target.observe_background(app)).await?;
    op.with_current(|connection| {
        observed.with_current(app, |_| {
            let session = acquired.session.as_ref().expect("private session");
            if !app.state::<AppState>().ssh.is_active(&session.id) {
                return Err(AppError::validation("ssh.sessionMissing"));
            }
            let session = acquired.session.take().expect("private session");
            connection.session = Some(session.clone());
            connection.acquired = true;
            Ok(session)
        })
    })
}

pub(super) fn dispose(app: &AppHandle, pending: &Pending) {
    let mut connection = pending.connection.lock().unwrap_or_else(|e| e.into_inner());
    if connection.acquired {
        if let Some(session) = connection.session.take() {
            let _ = session::disconnect(app, &session.id);
        }
    }
}

/// Drop/cancel also retires only this exact pending entry and its private session.
struct Acceptance<'a> {
    app: &'a AppHandle,
    id: &'a str,
    pending: &'a std::sync::Arc<Pending>,
}
impl Drop for Acceptance<'_> {
    fn drop(&mut self) {
        if let Some(removed) = self
            .app
            .state::<AppState>()
            .runners
            .browsers
            .remove_matching(self.id, self.pending)
        {
            dispose(self.app, &removed);
        }
    }
}

pub(super) async fn accept(
    app: &AppHandle,
    id: &str,
    pending: &std::sync::Arc<Pending>,
) -> AppResult<super::contracts::Target> {
    let (op, review) = Operation::accept(app, pending)?;
    let _cleanup = Acceptance { app, id, pending };
    let observed = if let Some(review) = review {
        Some(
            registry::guard(pending, async {
                let target = session::review::Target::capture_background(app, &review).await?;
                target.observe_background(app).await
            })
            .await?,
        )
    } else {
        None
    };
    let state = app.state::<AppState>();
    // Match the same registry entry at final admission; a reused request id may
    // never transfer a former pending connection to the new requester.
    op.with_current(|connection| {
        let session = connection
            .session
            .as_ref()
            .ok_or_else(|| AppError::validation("ssh.sessionMissing"))?;
        if connection.acquired {
            let observed = observed
                .as_ref()
                .ok_or_else(|| AppError::validation("plugin.runners.browserExpired"))?;
            observed.with_current(app, |_| {
                if !state.ssh.is_active(&session.id) {
                    return Err(AppError::validation("ssh.sessionMissing"));
                }
                state.ssh.publish_user_managed(&session.id)
            })?;
        } else if !destination::reusable(app, &pending.record, session) {
            return Err(AppError::validation("ssh.sessionMissing"));
        }
        let target = super::contracts::Target {
            session: session.clone(),
            directory: pending.record.deployment.directory.clone(),
            acquired: connection.acquired,
        };
        connection.acquired = false;
        connection.session = None;
        Ok(target)
    })
}
