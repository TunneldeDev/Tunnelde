//! Read-only negotiation against the exact recorded helper and verified target.
pub(crate) mod contracts;
mod decode;
use super::{transport, Deployment, HostContext};
use contracts::{Reason, Result};
use std::time::Duration;

pub(super) async fn observe(
    context: &HostContext,
    session: &str,
    deployment: &Deployment,
) -> Result {
    let response = transport::exchange(
        context,
        session,
        deployment,
        vec!["--capabilities".into()],
        None,
        transport::Limits {
            timeout: Duration::from_secs(5),
            output: decode::MAX_OUTPUT,
        },
    )
    .await;
    classify(response)
}

fn classify(response: std::result::Result<transport::Output, transport::Failure>) -> Result {
    let failed = |reason, exit_code| Result::Unavailable { reason, exit_code };
    match response {
        Err(transport::Failure::Timeout) => failed(Reason::Timeout, None),
        Err(transport::Failure::OutputTooLarge) => failed(Reason::OutputTooLarge, None),
        Err(transport::Failure::Connection(_)) => failed(Reason::Transport, None),
        Ok(output) => match output.code {
            None => failed(Reason::MissingExitStatus, None),
            Some(code) if code != 0 => failed(Reason::NonzeroExit, Some(code)),
            Some(_) => match decode::decode(&output.stdout) {
                Ok(envelope) => Result::Available { envelope },
                Err(reason) => failed(reason, None),
            },
        },
    }
}

#[cfg(test)]
mod compatibility;
#[cfg(test)]
mod tests;
