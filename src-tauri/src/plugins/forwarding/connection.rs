//! Connections requested through the host credential dialog are exclusive acquisitions.
//! They never share a pending native connect promise with another panel.
use super::{access, Origin};
use crate::{
    error::{AppError, AppResult},
    ssh::{SessionInfo, SshConnectRequest},
    state::AppState,
};
use tauri::{AppHandle, Manager};

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

#[tauri::command]
pub async fn forwarding_provider_connect(
    app: AppHandle,
    origin: Origin,
    mut request: SshConnectRequest,
) -> AppResult<SessionInfo> {
    let scope = access::resolve(&app, &origin)?;
    if request.host_id != scope.host {
        return Err(AppError::validation("ssh.sessionMissing"));
    }
    request.background = true;
    request.purpose = Some("forwarding".into());
    let state = app.state::<AppState>();
    let reservation = access::with_authorized(&app, &scope, true, |_| {
        state.plugins.sessions.forget(|id| !state.ssh.is_active(id));
        state.plugins.sessions.reserve(scope.lease.clone(), None)
    })?;
    let mut pending = scope
        .guard(state.plugins.security.guard(&scope.lease, async {
            let session = tokio::time::timeout(
                std::time::Duration::from_secs(120),
                crate::ssh::session::connect_unpublished(app.clone(), request),
            )
            .await
            .map_err(|_| AppError::Ssh("ssh.timeout".into()))??;
            Ok(PendingConnection {
                app: app.clone(),
                session: Some(session),
            })
        }))
        .await?;
    let session = pending.session.as_ref().expect("unpublished connection");
    access::with_authorized(&app, &scope, true, |owned| {
        if !state.ssh.is_active(&session.id) {
            return Err(AppError::validation("ssh.sessionMissing"));
        }
        reservation
            .commit(session.id.clone())
            .map_err(|_| AppError::validation("plugin.forwarding.expired"))?;
        owned.insert(session.id.clone());
        Ok(())
    })?;
    Ok(pending
        .session
        .take()
        .expect("connection assigned to scope"))
}

/// An acknowledged connection survives provider replacement, but remains runtime-owned.
#[tauri::command]
pub fn forwarding_provider_accept_connection(
    app: AppHandle,
    origin: Origin,
    session_id: String,
) -> AppResult<()> {
    let scope = access::resolve(&app, &origin)?;
    access::with_authorized(&app, &scope, true, |owned| {
        if !owned.contains(&session_id) || !app.state::<AppState>().ssh.is_active(&session_id) {
            return Err(AppError::validation("ssh.sessionMissing"));
        }
        app.state::<AppState>().ssh.publish(&session_id)?;
        owned.remove(&session_id);
        Ok(())
    })?;
    crate::logs::record(
        &app.state::<AppState>().db,
        "ssh.connect",
        Some(&scope.host),
    );
    crate::ssh::session::announce_connection(&app);
    Ok(())
}

#[tauri::command]
pub fn forwarding_provider_disconnect(
    app: AppHandle,
    origin: Origin,
    session_id: String,
) -> AppResult<()> {
    let scope = access::resolve(&app, &origin)?;
    access::with_authorized(&app, &scope, true, |_| {
        if !app.state::<AppState>().ssh.list().iter().any(|session| {
            session.id == session_id
                && session.host_id == scope.host
                && session.purpose.as_deref() == Some("forwarding")
        }) {
            return Err(AppError::validation("ssh.sessionMissing"));
        }
        crate::ssh::disconnect(&app, &session_id).map(|_| ())
    })
}
