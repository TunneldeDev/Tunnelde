//! Native task-bound metadata observation, independent of process control/cleanup.
pub(crate) mod contracts;
mod observation;
mod receipt;
use crate::{
    error::AppResult,
    plugins::runners::{capabilities, transport, HostContext, Record},
};
use std::time::Duration;

pub(super) async fn observe(
    context: &HostContext,
    session: &str,
    record: &Record,
    check: impl FnMut() -> AppResult<()>,
) -> AppResult<contracts::Result> {
    observation::observe(
        record,
        check,
        capabilities::observe(context, session, &record.deployment),
        |nonce| async move {
            let permit = record
                .admission
                .as_ref()
                .ok_or_else(|| {
                    crate::error::AppError::validation("plugin.runners.invalidMetadata")
                })?
                .token()?;
            transport::exchange(
                context,
                session,
                &record.deployment,
                vec![
                    "inspect-artifacts".into(),
                    "--directory".into(),
                    record.deployment.directory.clone(),
                    "--id".into(),
                    record.runner_id.clone(),
                    "--admission".into(),
                    permit.into(),
                    "--observation".into(),
                    nonce,
                ],
                None,
                transport::Limits {
                    timeout: Duration::from_secs(12),
                    output: receipt::MAX_OUTPUT,
                },
            )
            .await
        },
    )
    .await
}

#[cfg(test)]
mod compatibility;
#[cfg(test)]
mod tests;
