//! Bounded SSH helper protocol; never owns repository locks.
use super::{Deployment, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::Value;
use std::time::Duration;
use tauri::Manager;

mod channel;

pub(super) struct Limits {
    pub timeout: Duration,
    pub output: usize,
}

pub(super) struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: Option<u32>,
}

pub(super) enum Failure {
    Connection(AppError),
    Timeout,
    OutputTooLarge,
}

impl From<AppError> for Failure {
    fn from(error: AppError) -> Self {
        Self::Connection(error)
    }
}

pub(super) async fn exec(
    context: &HostContext,
    session: &str,
    deployment: &Deployment,
    args: Vec<String>,
    input: Option<String>,
) -> AppResult<Value> {
    let output = exchange(
        context,
        session,
        deployment,
        args,
        input,
        Limits {
            timeout: Duration::from_secs(45),
            output: 1024 * 1024,
        },
    )
    .await;
    decode(output)
}

/// Launch and prompt input must still belong to the original authorized record
/// after channel negotiation. Cleanup and host-owned inspection use `exec`.
pub(super) async fn exec_current(
    context: &HostContext,
    session: &str,
    record: &super::Record,
    args: Vec<String>,
    input: Option<String>,
) -> AppResult<Value> {
    let output = exchange_checked(
        context,
        session,
        &record.deployment,
        args,
        input,
        Limits {
            timeout: Duration::from_secs(45),
            output: 1024 * 1024,
        },
        || {
            super::authorize(context, &["ssh.exec"])?;
            super::repository::require_current(context, record)
        },
    )
    .await;
    decode(output)
}

fn decode(output: Result<Output, Failure>) -> AppResult<Value> {
    let output = output.map_err(|error| match error {
        Failure::Connection(error) => error,
        Failure::Timeout => AppError::validation("plugin.runners.timeout"),
        Failure::OutputTooLarge => AppError::validation("plugin.runners.outputTooLarge"),
    })?;
    if output.code != Some(0) {
        return Err(AppError::validation(format!(
            "plugin.runners.commandFailed:{}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(512)
                .collect::<String>()
        )));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| AppError::validation("plugin.runners.invalidResponse"))
}

/// Each protocol chooses its own bounds; discovery never inherits a task's 1 MiB budget.
pub(super) async fn exchange(
    context: &HostContext,
    session: &str,
    deployment: &Deployment,
    args: Vec<String>,
    input: Option<String>,
    limits: Limits,
) -> Result<Output, Failure> {
    exchange_checked(context, session, deployment, args, input, limits, || Ok(())).await
}

async fn exchange_checked(
    context: &HostContext,
    session: &str,
    deployment: &Deployment,
    args: Vec<String>,
    input: Option<String>,
    limits: Limits,
    current: impl Fn() -> AppResult<()>,
) -> Result<Output, Failure> {
    let command = crate::plugins::tasks::remote_command(
        &deployment.runner,
        &args,
        None,
        &deployment.platform,
    )?;
    let handle = context.app.state::<AppState>().ssh.handle(session)?;
    channel::exchange(
        async {
            handle
                .channel_open_session()
                .await
                .map_err(|error| AppError::Ssh(error.to_string()))
        },
        command,
        input,
        limits,
        || {
            current()?;
            super::identity::verify(
                deployment,
                &super::identity::capture(&context.app, session)?,
            )
        },
    )
    .await
}
