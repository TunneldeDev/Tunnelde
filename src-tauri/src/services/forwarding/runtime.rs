//! Prepare network resources without holding locks; authorize their final admission separately.
use super::{
    contract::{validate, RevisionedRule},
    service,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use tauri::{AppHandle, Manager};

pub(crate) struct PendingStart {
    app: AppHandle,
    entry: RevisionedRule,
    session_id: String,
    listener: crate::ssh::forward::PendingForward,
}
impl PendingStart {
    /// Lock order: caller policy/scope -> forwarding registry -> database.
    pub(crate) fn commit(self) -> AppResult<()> {
        let state = self.app.state::<AppState>();
        self.listener.commit(&state.forwards, || {
            if !state.ssh.list().iter().any(|session| {
                session.id == self.session_id && session.host_id == self.entry.rule.host_id
            }) {
                return Err(AppError::validation("ssh.sessionMissing"));
            }
            if !service(&state)
                .rules()?
                .iter()
                .any(|saved| saved.rule == self.entry.rule && saved.revision == self.entry.revision)
            {
                return Err(AppError::validation("forward.changed"));
            }
            Ok(())
        })
    }
}

pub(crate) async fn prepare_checked(
    app: &AppHandle,
    id: &str,
    session_id: &str,
    owner: Option<(String, u64)>,
    expected: Option<&str>,
) -> AppResult<PendingStart> {
    let state = app.state::<AppState>();
    let entry = service(&state)
        .rules()?
        .into_iter()
        .find(|entry| entry.rule.id == id)
        .ok_or_else(|| AppError::validation("forward.missing"))?;
    if expected.is_some_and(|expected| expected != entry.revision) {
        return Err(AppError::validation("forward.changed"));
    }
    validate(&entry.rule)?;
    if !state
        .ssh
        .list()
        .iter()
        .any(|session| session.id == session_id && session.host_id == entry.rule.host_id)
    {
        return Err(AppError::validation("ssh.sessionMissing"));
    }
    let listener = crate::ssh::forward::prepare(
        &state.forwards,
        &entry.rule,
        session_id,
        state.ssh.handle(session_id)?,
        state.ssh.remote_routes(session_id)?,
        owner,
    )
    .await?;
    Ok(PendingStart {
        app: app.clone(),
        entry,
        session_id: session_id.into(),
        listener,
    })
}
pub async fn start_checked(
    app: &AppHandle,
    id: &str,
    session_id: &str,
    owner: Option<(String, u64)>,
    expected: Option<&str>,
) -> AppResult<()> {
    prepare_checked(app, id, session_id, owner, expected)
        .await?
        .commit()
}
pub(crate) fn take_checked(
    app: &AppHandle,
    id: &str,
    revision: &str,
    runtime: &str,
) -> AppResult<crate::ssh::forward::StoppedForward> {
    let state = app.state::<AppState>();
    state.forwards.take_checked(id, Some(runtime), || {
        if !service(&state)
            .rules()?
            .iter()
            .any(|entry| entry.rule.id == id && entry.revision == revision)
        {
            return Err(AppError::validation("forward.changed"));
        }
        Ok(())
    })
}
pub async fn stop(app: &AppHandle, id: &str) -> AppResult<()> {
    app.state::<AppState>().forwards.stop(id).await
}
