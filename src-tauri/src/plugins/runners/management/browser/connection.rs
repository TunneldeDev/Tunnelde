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
    let (op, target) = Operation::begin(app, pending)?;
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
    op.with_current(|connection| {
        target.with_current(app, |_| {
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

pub(super) fn accept(app: &AppHandle, pending: &Pending) -> AppResult<super::contracts::Target> {
    let mut connection = pending.connection.lock().unwrap_or_else(|e| e.into_inner());
    if connection.busy {
        return Err(AppError::validation("plugin.runners.busy"));
    }
    destination::with_current(app, pending, || {
        let session = connection
            .session
            .as_ref()
            .ok_or_else(|| AppError::validation("ssh.sessionMissing"))?;
        let state = app.state::<AppState>();
        if connection.acquired {
            let review = connection
                .review
                .as_ref()
                .ok_or_else(|| AppError::validation("plugin.runners.browserExpired"))?;
            let target = session::review::Target::capture(app, review)?;
            target.with_current(app, |_| state.ssh.publish_user_managed(&session.id))?;
        } else if !destination::reusable(app, &pending.record, session) {
            return Err(AppError::validation("ssh.sessionMissing"));
        }
        // No await between validation/publication and transferring to native user ownership.
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
