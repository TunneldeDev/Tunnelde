//! Destination and package-control checks shared by RPCs and host recovery.
use super::{Deployment, Record};
use crate::{
    error::{AppError, AppResult},
    ssh::session::SessionIdentity,
    state::AppState,
};
use tauri::{AppHandle, Manager};

pub(super) fn capture(app: &AppHandle, session: &str) -> AppResult<SessionIdentity> {
    app.state::<AppState>().ssh.identity(session)
}

pub(super) fn verify(deployment: &Deployment, actual: &SessionIdentity) -> AppResult<()> {
    let expected = deployment
        .identity
        .as_ref()
        .ok_or_else(|| AppError::validation("plugin.runners.identityReviewRequired"))?;
    if deployment.host_id != actual.host_id || expected != actual {
        return Err(AppError::validation("plugin.runners.destinationChanged"));
    }
    Ok(())
}

pub(super) fn controller(record: &Record, fingerprint: &str) -> AppResult<()> {
    if record.controller() != fingerprint || fingerprint.is_empty() {
        return Err(AppError::validation("plugin.runners.controlReviewRequired"));
    }
    Ok(())
}

pub(super) fn select(
    record: &Record,
    sessions: &[(String, SessionIdentity)],
    legacy_review: bool,
) -> AppResult<String> {
    let candidates: Vec<_> = sessions
        .iter()
        .filter(|(_, value)| value.host_id == record.deployment.host_id)
        .collect();
    if candidates.is_empty() {
        return Err(AppError::validation("ssh.sessionMissing"));
    }
    if record.deployment.identity.is_some() {
        return candidates
            .into_iter()
            .find(|(_, actual)| verify(&record.deployment, actual).is_ok())
            .map(|(id, _)| id.clone())
            .ok_or_else(|| AppError::validation("plugin.runners.destinationChanged"));
    }
    if !legacy_review {
        return Err(AppError::validation(
            "plugin.runners.identityReviewRequired",
        ));
    }
    let first = candidates[0];
    if candidates.iter().any(|(_, actual)| actual != &first.1) {
        return Err(AppError::validation("plugin.runners.destinationAmbiguous"));
    }
    Ok(first.0.clone())
}

pub(super) fn sessions(app: &AppHandle) -> Vec<(String, SessionIdentity)> {
    let state = app.state::<AppState>();
    let mut values: Vec<_> = state
        .ssh
        .list()
        .into_iter()
        .filter_map(|session| {
            state
                .ssh
                .identity(&session.id)
                .ok()
                .map(|identity| (session.id, identity))
        })
        .collect();
    values.sort_by(|left, right| left.0.cmp(&right.0));
    values
}

#[cfg(test)]
mod tests;
