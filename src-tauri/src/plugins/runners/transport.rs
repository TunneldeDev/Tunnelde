//! Bounded SSH helper protocol; never owns repository locks.
use super::{Deployment, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use russh::ChannelMsg;
use serde_json::Value;
use std::time::Duration;
use tauri::Manager;

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
    .await
    .map_err(|error| match error {
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
    super::identity::verify(
        deployment,
        &super::identity::capture(&context.app, session)?,
    )?;
    let command = crate::plugins::tasks::remote_command(
        &deployment.runner,
        &args,
        None,
        &deployment.platform,
    )?;
    let handle = context.app.state::<AppState>().ssh.handle(session)?;
    let deadline = tokio::time::Instant::now() + limits.timeout;
    let mut channel = tokio::time::timeout_at(deadline, handle.channel_open_session())
        .await
        .map_err(|_| Failure::Timeout)?
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let result = tokio::time::timeout_at(deadline, async {
        channel
            .exec(true, command)
            .await
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        if let Some(input) = input {
            channel
                .data(input.as_bytes())
                .await
                .map_err(|error| AppError::Ssh(error.to_string()))?;
        }
        channel
            .eof()
            .await
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut code = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if data.len() > limits.output.saturating_sub(stdout.len() + stderr.len()) {
                        return Err(Failure::OutputTooLarge);
                    }
                    stdout.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    if data.len() > limits.output.saturating_sub(stdout.len() + stderr.len()) {
                        return Err(Failure::OutputTooLarge);
                    }
                    stderr.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(Output {
            stdout,
            stderr,
            code,
        })
    })
    .await
    .map_err(|_| Failure::Timeout)
    .and_then(|value| value);
    // Closing the SSH channel is best effort, not proof of remote process exit.
    let _ = tokio::time::timeout(Duration::from_millis(100), channel.close()).await;
    result
}
