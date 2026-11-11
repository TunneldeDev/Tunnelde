use super::{super::query, registry::Pending};
use crate::{
    error::{AppError, AppResult},
    models::Host,
    plugins::runners::{identity, Record},
    ssh::{session::SessionIdentity, SessionInfo},
    state::AppState,
};
use tauri::{AppHandle, Manager};

pub(super) fn identity(record: &Record) -> AppResult<&SessionIdentity> {
    record
        .deployment
        .identity
        .as_ref()
        .ok_or_else(|| AppError::validation("plugin.runners.identityReviewRequired"))
}

pub(super) fn current(app: &AppHandle, pending: &Pending) -> AppResult<()> {
    if *pending.cancelled.borrow() {
        return Err(AppError::validation("plugin.runners.browserExpired"));
    }
    let context = query::context(app, &pending.plugin_id)?;
    query::selected(&context, &pending.token)?;
    Ok(())
}

pub(super) fn host(app: &AppHandle, record: &Record) -> AppResult<Host> {
    let expected = identity(record)?;
    let host = crate::services::hosts::resolve(app, &expected.host_id)?;
    expected.verify_host(&host)?;
    Ok(host)
}

pub(super) fn reusable(app: &AppHandle, record: &Record, session: &SessionInfo) -> bool {
    let state = app.state::<AppState>();
    session.purpose.is_none()
        && state.ssh.user_managed(&session.id)
        && !state.plugins.sessions.contains(|id| id == &session.id)
        && state
            .ssh
            .identity(&session.id)
            .is_ok_and(|actual| identity::verify(&record.deployment, &actual).is_ok())
}
