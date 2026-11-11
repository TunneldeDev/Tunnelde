use super::{scope::Scope, Origin, Registry};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub(super) const READ: &[&str] = &["ui.trusted", "hosts.read", "forwards.read"];
pub(super) const WRITE: &[&str] = &[
    "ui.trusted",
    "hosts.read",
    "forwards.read",
    "forwards.write",
];

pub(super) fn resolve(app: &AppHandle, origin: &Origin) -> AppResult<Arc<Scope>> {
    let scope = app.state::<Registry>().get(&origin.scope, &origin.token)?;
    let current = app
        .state::<super::super::frontend::Registry>()
        .lease(&origin.token)?;
    if current.id != scope.lease.id
        || current.generation != scope.lease.generation
        || current.fingerprint != scope.lease.fingerprint
    {
        return Err(AppError::validation("plugin.forwarding.expired"));
    }
    with_authorized(app, &scope, false, |_| Ok(()))?;
    Ok(scope)
}

pub(super) fn with_authorized<T>(
    app: &AppHandle,
    scope: &Scope,
    write: bool,
    operation: impl FnOnce(&mut std::collections::HashSet<String>) -> AppResult<T>,
) -> AppResult<T> {
    let state = app.state::<AppState>();
    // Admission order: frontend token -> policy -> settings -> scope -> resource.
    // Replacement cannot invalidate a token half way through an accepted mutation.
    app.state::<super::super::frontend::Registry>()
        .with_lease(&scope.token, |current| {
            if current.id != scope.lease.id
                || current.generation != scope.lease.generation
                || current.fingerprint != scope.lease.fingerprint
            {
                return Err(AppError::validation("plugin.forwarding.expired"));
            }
            state.plugins.security.with_authorized(
                &scope.lease,
                if write { WRITE } else { READ },
                || {
                    let settings = state.settings.read().unwrap_or_else(|e| e.into_inner());
                    if state
                        .ui_provider_revision
                        .load(std::sync::atomic::Ordering::SeqCst)
                        != scope.selection_revision
                        || !settings
                            .ui_providers
                            .get("forwarding")
                            .is_some_and(|selection| {
                                selection.plugin_id == scope.lease.id
                                    && selection.view_id == scope.view
                            })
                    {
                        return Err(AppError::validation("plugin.forwarding.expired"));
                    }
                    scope.with_live(operation)
                },
            )
        })
}

pub(super) fn check_rule(
    app: &AppHandle,
    scope: &Scope,
    id: &str,
    revision: &str,
) -> AppResult<()> {
    if !crate::services::forwarding::list_revisioned(app)?
        .iter()
        .any(|entry| {
            entry.info.rule.id == id
                && entry.info.rule.host_id == scope.host
                && entry.revision == revision
        })
    {
        return Err(AppError::validation("forward.changed"));
    }
    Ok(())
}
