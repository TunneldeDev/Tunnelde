use super::{
    destination,
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

struct Busy<'a>(&'a Pending);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0
            .connection
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .busy = false;
    }
}

pub(super) async fn connect(
    app: &AppHandle,
    pending: &Pending,
    mut request: SshConnectRequest,
) -> AppResult<SessionInfo> {
    destination::current(app, pending)?;
    destination::host(app, &pending.record)?;
    let expected = destination::identity(&pending.record)?;
    if request.host_id != expected.host_id {
        return Err(AppError::validation("plugin.runners.destinationChanged"));
    }
    {
        let mut state = pending.connection.lock().unwrap_or_else(|e| e.into_inner());
        if state.busy || state.session.is_some() {
            return Err(AppError::validation("plugin.runners.busy"));
        }
        state.busy = true;
    }
    let _busy = Busy(pending);
    // A native recovery browser never opens a terminal or a forwarding connection.
    request.background = true;
    request.purpose = None;
    let result = registry::guard(pending, async {
        let session = session::connect_bound(app.clone(), request, expected).await?;
        let mut acquired = Acquired {
            app: app.clone(),
            session: Some(session),
        };
        destination::current(app, pending)?;
        destination::host(app, &pending.record)?;
        let mut connection = pending.connection.lock().unwrap_or_else(|e| e.into_inner());
        // Cancellation can race with the network return and this lock acquisition.
        destination::current(app, pending)?;
        let session = acquired.session.take().expect("private session");
        connection.session = Some(session.clone());
        connection.acquired = true;
        Ok(session)
    })
    .await;
    result
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
    destination::current(app, pending)?;
    let session = connection
        .session
        .as_ref()
        .ok_or_else(|| AppError::validation("ssh.sessionMissing"))?;
    let state = app.state::<AppState>();
    if connection.acquired {
        destination::host(app, &pending.record)?;
        state.ssh.publish_user_managed(&session.id)?;
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
}
