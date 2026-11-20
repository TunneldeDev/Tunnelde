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
    target: crate::ssh::session::review::Target,
    listener: crate::ssh::forward::PendingForward,
}
impl PendingStart {
    /// Lock order: caller policy/scope -> forwarding registry -> database.
    pub(crate) fn session(&self) -> String {
        self.session_id.clone()
    }
    pub(crate) fn commit(self) -> AppResult<()> {
        let state = self.app.state::<AppState>();
        self.listener.commit(&state.forwards, || {
            self.target.with_current(&self.app, |conn| {
                if !state.ssh.is_active(&self.session_id) {
                    return Err(AppError::validation("ssh.sessionMissing"));
                }
                let saved = super::repository::find(conn, &self.entry.rule.id)?;
                if saved.is_none_or(|saved| {
                    saved.rule != self.entry.rule
                        || saved.revision != self.entry.revision
                        || saved.group_id != self.entry.group_id
                }) {
                    return Err(AppError::validation("forward.changed"));
                }
                state.ssh.publish(&self.session_id)
            })
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
        .rule(id)?
        .ok_or_else(|| AppError::validation("forward.missing"))?;
    if expected.is_some_and(|expected| expected != entry.revision) {
        return Err(AppError::validation("forward.changed"));
    }
    validate(&entry.rule)?;
    let handle = app.clone();
    let host_id = entry.rule.host_id.clone();
    let target = crate::services::credentials::inspect(move || {
        let host = crate::services::hosts::resolve(&handle, &host_id)?;
        crate::ssh::session::review::Target::from_displayed(&handle, &host)
    })
    .await?;
    let connection = state
        .forward_automation
        .connections
        .existing(app, &entry, &target, session_id)
        .await?;
    prepare_on(app, entry, target, connection, owner).await
}
async fn prepare_on(
    app: &AppHandle,
    entry: RevisionedRule,
    target: crate::ssh::session::review::Target,
    connection: std::sync::Arc<super::connections::Connection>,
    owner: Option<(String, u64)>,
) -> AppResult<PendingStart> {
    let state = app.state::<AppState>();
    let session_id = connection.info.id.clone();
    let listener = crate::ssh::forward::prepare_scoped(
        &state.forwards,
        &entry.rule,
        &session_id,
        state.ssh.handle(&session_id)?,
        state.ssh.remote_routes(&session_id)?,
        owner,
        connection,
    )
    .await?;
    Ok(PendingStart {
        app: app.clone(),
        entry,
        session_id,
        target,
        listener,
    })
}
pub(crate) async fn prepare_managed(
    app: &AppHandle,
    id: &str,
    expected: Option<&str>,
    owner: Option<(String, u64)>,
    request: Option<crate::ssh::SshConnectRequest>,
    review: Option<crate::ssh::session::review::Review>,
) -> AppResult<PendingStart> {
    let entry = super::repository::find_entry(app, id)?;
    if expected.is_some_and(|revision| revision != entry.revision) {
        return Err(AppError::validation("forward.changed"));
    }
    validate(&entry.rule)?;
    let handle = app.clone();
    let host_id = entry.rule.host_id.clone();
    let target = crate::services::credentials::inspect(move || {
        if let Some(review) = review {
            if review.host_id != host_id {
                return Err(AppError::validation("ssh.connectionChanged"));
            }
            crate::ssh::session::review::Target::capture(&handle, &review)
        } else {
            let host = crate::services::hosts::resolve(&handle, &host_id)?;
            crate::ssh::session::review::Target::from_displayed(&handle, &host)
        }
    })
    .await?;
    let request = request.unwrap_or_else(|| super::connections::request(&entry.rule.host_id));
    let connection = app
        .state::<AppState>()
        .forward_automation
        .connections
        .acquire(app, &entry, &target, request)
        .await?;
    prepare_on(app, entry, target, connection, owner).await
}
pub(crate) async fn start_managed(
    app: &AppHandle,
    id: &str,
    expected: Option<&str>,
    request: Option<crate::ssh::SshConnectRequest>,
    review: Option<crate::ssh::session::review::Review>,
) -> AppResult<crate::ssh::SessionInfo> {
    let attempt = super::automation::Attempt::begin(app, id, expected)?;
    let result = tokio::select! { biased;
        _=attempt.cancelled()=>Err(AppError::validation("forward.startCancelled")),
        result=prepare_managed(app,id,Some(attempt.revision()),None,request,review)=>result,
    };
    let session = result
        .as_ref()
        .map(|pending| pending.session())
        .unwrap_or_default();
    let result = result.and_then(|pending| attempt.commit(|| pending.commit()));
    attempt.finish(&result, &session);
    result?;
    let state = app.state::<AppState>();
    state.ssh.publish(&session)?;
    crate::ssh::session::announce_connection(app);
    state
        .ssh
        .list()
        .into_iter()
        .find(|item| item.id == session)
        .ok_or_else(|| AppError::validation("ssh.sessionMissing"))
}

pub async fn start_checked(
    app: &AppHandle,
    id: &str,
    session_id: &str,
    owner: Option<(String, u64)>,
    expected: Option<&str>,
) -> AppResult<()> {
    let attempt = if owner.is_none() {
        Some(super::automation::Attempt::begin(app, id, expected)?)
    } else {
        None
    };
    let result = async {
        let pending = if let Some(attempt) = &attempt {
            tokio::select! { biased;
                _ = attempt.cancelled() => return Err(AppError::validation("forward.startCancelled")),
                result = prepare_checked(app, id, session_id, owner, Some(attempt.revision())) => result?,
            }
        } else { prepare_checked(app, id, session_id, owner, expected).await? };
        if let Some(attempt) = &attempt { attempt.commit(|| pending.commit()) }
        else { pending.commit() }
    }.await;
    if let Some(attempt) = attempt {
        attempt.finish(&result, session_id);
    }
    result
}
impl super::Forwarding<'_> {
    pub(super) fn take_checked(
        &self,
        id: &str,
        revision: &str,
        runtime: Option<&str>,
    ) -> AppResult<crate::ssh::forward::StoppedForward> {
        // Registry -> DB, matching start admission and conditional edits. Both
        // rule revision and listener incarnation must still be current under
        // the same registry lock before invalidating tickets or taking a socket.
        self.registry.take_snapshot(id, runtime, || {
            if !self
                .rule(id)?
                .is_some_and(|entry| entry.revision == revision)
            {
                return Err(AppError::validation("forward.changed"));
            }
            Ok(())
        })
    }
}
pub(crate) fn take_checked(
    app: &AppHandle,
    id: &str,
    revision: &str,
    runtime: &str,
) -> AppResult<crate::ssh::forward::StoppedForward> {
    service(&app.state::<AppState>()).take_checked(id, revision, Some(runtime))
}
pub(crate) fn take_manual_stop(
    app: &AppHandle,
    id: &str,
    revision: &str,
    runtime: Option<&str>,
) -> AppResult<crate::ssh::forward::StoppedForward> {
    let state = app.state::<AppState>();
    // Automation -> registry -> DB. Native-window ingress additionally holds
    // exact document/lease authority over this entire synchronous transaction.
    state
        .forward_automation
        .pause_after(id, || service(&state).take_checked(id, revision, runtime))
}
pub(crate) async fn stop_checked(
    app: &AppHandle,
    id: &str,
    revision: &str,
    runtime: Option<&str>,
) -> AppResult<()> {
    let stopping = take_manual_stop(app, id, revision, runtime)?;
    super::automation::changed(app);
    // take_checked already spawned cleanup, so cancelling delivery cannot
    // abandon the taken listener or its group-connection lifetime.
    stopping.finish().await
}
pub async fn stop(app: &AppHandle, id: &str) -> AppResult<()> {
    super::automation::pause(app, id);
    app.state::<AppState>().forwards.stop(id).await
}
