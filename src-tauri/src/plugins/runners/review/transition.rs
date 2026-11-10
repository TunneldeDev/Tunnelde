use super::Kind;
use crate::{
    error::{AppError, AppResult},
    plugins::runners::{identity, lifecycle, Record},
    ssh::session::SessionIdentity,
};

pub(super) fn validate(
    record: &Record,
    kind: Kind,
    actual: &SessionIdentity,
    fingerprint: &str,
) -> AppResult<()> {
    if record.deployment.host_id != actual.host_id {
        return Err(AppError::validation("plugin.runners.destinationChanged"));
    }
    match kind {
        Kind::Destination => {
            if record.deployment.identity.is_some() {
                return Err(AppError::validation(
                    "plugin.runners.identityAlreadyReviewed",
                ));
            }
        }
        Kind::Control => {
            identity::verify(&record.deployment, actual)?;
            if record.runner_id == "deployment"
                || record.stop_pending
                || record.terminal_status.is_some()
                || fingerprint.is_empty()
            {
                return Err(AppError::validation("plugin.runners.controlUnavailable"));
            }
            if record.controller() == fingerprint {
                return Err(AppError::validation(
                    "plugin.runners.controlAlreadyReviewed",
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn apply(
    record: &mut Record,
    kind: Kind,
    actual: SessionIdentity,
    fingerprint: &str,
    generation: u64,
) -> AppResult<()> {
    validate(record, kind, &actual, fingerprint)?;
    match kind {
        Kind::Destination => record.deployment.identity = Some(actual),
        Kind::Control => {
            record.controller_fingerprint = Some(fingerprint.into());
            record.runtime_owner = Some(lifecycle::Owner::current(generation));
        }
    }
    record.advance()
}
