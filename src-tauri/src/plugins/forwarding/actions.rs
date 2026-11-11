//! Provider mutations reuse host-owned CAS persistence and transport admission.
use super::{access, Origin};
use crate::{
    error::{AppError, AppResult},
    services::forwarding::{
        self,
        contract::{ForwardRule, RevisionedRule},
    },
    state::AppState,
};
use tauri::{AppHandle, Manager};

pub(crate) fn save(
    app: &AppHandle,
    origin: &Origin,
    rule: ForwardRule,
    expected: Option<&str>,
) -> AppResult<RevisionedRule> {
    let scope = access::resolve(app, origin)?;
    access::with_authorized(app, &scope, true, |_| {
        if rule.host_id != scope.host || (!rule.id.is_empty() && expected.is_none()) {
            return Err(AppError::validation("forward.changed"));
        }
        if let Some(revision) = expected {
            access::check_rule(app, &scope, &rule.id, revision)?;
        }
        forwarding::save_checked(app, rule, expected)
    })
}
pub(crate) fn remove(
    app: &AppHandle,
    origin: &Origin,
    id: &str,
    expected: Option<&str>,
) -> AppResult<()> {
    let scope = access::resolve(app, origin)?;
    access::with_authorized(app, &scope, true, |_| {
        let revision = expected.ok_or_else(|| AppError::validation("forward.changed"))?;
        access::check_rule(app, &scope, id, revision)?;
        forwarding::remove_checked(app, id, Some(revision))
    })
}
pub(crate) async fn start(
    app: &AppHandle,
    origin: &Origin,
    id: &str,
    session: &str,
    expected: Option<&str>,
) -> AppResult<()> {
    let scope = access::resolve(app, origin)?;
    let revision = expected.ok_or_else(|| AppError::validation("forward.changed"))?;
    access::with_authorized(app, &scope, true, |_| {
        access::check_rule(app, &scope, id, revision)
    })?;
    let state = app.state::<AppState>();
    if !state.ssh.list().iter().any(|item| {
        item.id == session
            && item.host_id == scope.host
            && item.purpose.as_deref() == Some("forwarding")
    }) {
        return Err(AppError::validation("ssh.sessionMissing"));
    }
    let prepared = scope
        .guard(state.plugins.security.guard(
            &scope.lease,
            forwarding::prepare_checked(
                app,
                id,
                session,
                Some((scope.lease.id.clone(), scope.lease.generation)),
                Some(revision),
            ),
        ))
        .await?;
    access::with_authorized(app, &scope, true, |_| prepared.commit())
}
pub(crate) async fn stop(
    app: &AppHandle,
    origin: &Origin,
    id: &str,
    revision: Option<&str>,
    runtime: Option<&str>,
) -> AppResult<()> {
    let scope = access::resolve(app, origin)?;
    let stopping = access::with_authorized(app, &scope, true, |_| {
        let revision = revision.ok_or_else(|| AppError::validation("forward.changed"))?;
        access::check_rule(app, &scope, id, revision)?;
        forwarding::take_checked(
            app,
            id,
            revision,
            runtime.ok_or_else(|| AppError::validation("forward.changed"))?,
        )
    })?;
    stopping.finish().await
}
