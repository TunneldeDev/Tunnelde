use super::contracts::Receipt;
use crate::{
    error::{AppError, AppResult},
    plugins::runners::{identity, transport, HostContext, Record},
};
use std::time::Duration;

pub(in crate::plugins::runners) enum Operation {
    Reserve,
    Stop,
    Status,
}

pub(in crate::plugins::runners) async fn request(
    context: &HostContext,
    session: &str,
    record: &Record,
    operation: Operation,
) -> AppResult<Receipt> {
    let token = record
        .admission
        .as_ref()
        .ok_or_else(|| AppError::validation("plugin.runners.invalidMetadata"))?
        .token()?;
    let stopping = matches!(operation, Operation::Stop);
    let operation = match operation {
        Operation::Reserve => "reserve-fenced",
        Operation::Stop => "stop-fenced",
        Operation::Status => "status-fenced",
    };
    let output = transport::exchange(
        context,
        session,
        &record.deployment,
        vec![
            operation.into(),
            "--directory".into(),
            record.deployment.directory.clone(),
            "--id".into(),
            record.runner_id.clone(),
            "--admission".into(),
            token.into(),
        ],
        None,
        transport::Limits {
            timeout: Duration::from_secs(15),
            output: 4096,
        },
    )
    .await
    .map_err(|error| match error {
        transport::Failure::Connection(error) => error,
        transport::Failure::Timeout => AppError::validation("plugin.runners.timeout"),
        transport::Failure::OutputTooLarge => AppError::validation("plugin.runners.outputTooLarge"),
    })?;
    identity::verify(
        &record.deployment,
        &identity::capture(&context.app, session)?,
    )?;
    if output.code != Some(0) {
        // Control data and helper diagnostics are not user-visible proof.
        tracing::debug!(plugin_id = %context.id, runner_id = %record.runner_id,
            operation, exit_code = ?output.code,
            reason = if output.code.is_none() { "missingExitStatus" } else { "nonzeroExit" },
            action = "retain_intent_and_reconcile", "runner admission response rejected");
        return Err(AppError::validation("plugin.runners.invalidResponse"));
    }
    let receipt = Receipt::parse(&output.stdout, record).inspect_err(|_| {
        tracing::debug!(plugin_id = %context.id, runner_id = %record.runner_id,
            operation, reason = "invalidReceipt", action = "retain_intent_and_reconcile",
            "runner admission response rejected");
    })?;
    if stopping && !receipt.cancelled() {
        return Err(AppError::validation("plugin.runners.invalidResponse"));
    }
    Ok(receipt)
}
