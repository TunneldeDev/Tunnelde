//! SSH startup admission and runtime operations; persistence stays in the domain service.
use super::{contract::validate, service};
use crate::{error::AppResult, state::AppState};
use tauri::{AppHandle, Manager};

pub async fn start_owned(
    app: &AppHandle,
    id: &str,
    session_id: &str,
    owner: Option<(String, u64)>,
) -> AppResult<()> {
    start_checked(app, id, session_id, owner, None).await
}
pub async fn start_checked(
    app: &AppHandle,
    id: &str,
    session_id: &str,
    owner: Option<(String, u64)>,
    expected: Option<&str>,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let entry = service(&state)
        .rules()?
        .into_iter()
        .find(|entry| entry.rule.id == id)
        .ok_or_else(|| crate::error::AppError::validation("forward.missing"))?;
    if expected.is_some_and(|expected| expected != entry.revision) {
        return Err(crate::error::AppError::validation("forward.changed"));
    }
    let rule = &entry.rule;
    validate(rule)?;
    if !state
        .ssh
        .list()
        .iter()
        .any(|session| session.id == session_id && session.host_id == rule.host_id)
    {
        return Err(crate::error::AppError::validation("ssh.sessionMissing"));
    }
    crate::ssh::forward::start_owned(
        &state.forwards,
        rule,
        session_id,
        state.ssh.handle(session_id)?,
        state.ssh.remote_routes(session_id)?,
        owner,
        || {
            if !state
                .ssh
                .list()
                .iter()
                .any(|session| session.id == session_id && session.host_id == rule.host_id)
            {
                return Err(crate::error::AppError::validation("ssh.sessionMissing"));
            }
            if !service(&state)
                .rules()?
                .iter()
                .any(|saved| saved.rule == *rule && saved.revision == entry.revision)
            {
                return Err(crate::error::AppError::validation("forward.changed"));
            }
            Ok(())
        },
    )
    .await
}
pub async fn stop(app: &AppHandle, id: &str) -> AppResult<()> {
    app.state::<AppState>().forwards.stop(id).await
}
