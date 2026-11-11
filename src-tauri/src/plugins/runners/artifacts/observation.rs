//! Checkpointed read-only sequence. No repository writes or process settlement.
use super::{
    contracts::{Result, UnsupportedReason},
    receipt,
};
use crate::{
    error::AppResult,
    plugins::runners::{admission, capabilities, transport, Record},
};
use std::future::Future;

pub(super) fn eligible(record: &Record) -> bool {
    record.runner_id != "deployment"
        && record.deployment_ready()
        && record
            .admission
            .as_ref()
            .is_some_and(|permit| permit.token().is_ok())
        && record.configuration_transport
            == Some(super::super::bootstrap::contracts::Configuration::InitializeV1)
        && record.configuration_state.is_none()
}

pub(super) fn supports(result: &capabilities::contracts::Result) -> bool {
    admission::supported(result)
        && matches!(result, capabilities::contracts::Result::Available { envelope }
        if envelope.features.iter().any(|feature| feature == "runner.artifact-observation.v1"))
}

pub(super) fn classify(
    response: std::result::Result<transport::Output, transport::Failure>,
    record: &Record,
    nonce: &str,
) -> Result {
    use capabilities::contracts::Reason;
    let unavailable = |reason, exit_code| Result::Unavailable { reason, exit_code };
    match response {
        Err(transport::Failure::Timeout) => unavailable(Reason::Timeout, None),
        Err(transport::Failure::OutputTooLarge) => unavailable(Reason::OutputTooLarge, None),
        Err(transport::Failure::Connection(_)) => unavailable(Reason::Transport, None),
        Ok(output) => match output.code {
            None => unavailable(Reason::MissingExitStatus, None),
            Some(code) if code != 0 => unavailable(Reason::NonzeroExit, Some(code)),
            Some(_) => receipt::decode(&output.stdout, record, nonce)
                .unwrap_or_else(|| unavailable(Reason::InvalidResponse, None)),
        },
    }
}

pub(super) async fn observe<D, R, F, C>(
    record: &Record,
    mut check: C,
    discover: D,
    request: R,
) -> AppResult<Result>
where
    D: Future<Output = capabilities::contracts::Result>,
    R: FnOnce(String) -> F,
    F: Future<Output = std::result::Result<transport::Output, transport::Failure>>,
    C: FnMut() -> AppResult<()>,
{
    check()?;
    if !eligible(record) {
        return Ok(Result::Unsupported {
            reason: UnsupportedReason::LegacyTask,
        });
    }
    let found = discover.await;
    check()?;
    if !supports(&found) {
        return Ok(match found {
            capabilities::contracts::Result::Unavailable { reason, exit_code } => {
                Result::Unavailable { reason, exit_code }
            }
            _ => Result::Unsupported {
                reason: UnsupportedReason::HelperCapability,
            },
        });
    }
    let nonce = uuid::Uuid::new_v4().to_string();
    let output = request(nonce.clone()).await;
    check()?;
    Ok(classify(output, record, &nonce))
}
