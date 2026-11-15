//! One bounded exchange; no command or payload crosses a failed dispatch fence.
use super::{Failure, Limits, Output};
use crate::error::{AppError, AppResult};
use russh::{client, Channel, ChannelMsg};
use std::{
    future::Future,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::Semaphore;

pub(super) async fn exchange(
    open: impl Future<Output = AppResult<Channel<client::Msg>>> + Send + 'static,
    command: String,
    input: Option<String>,
    limits: Limits,
    current: impl Fn() -> AppResult<()>,
) -> Result<Output, Failure> {
    static OPENS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    exchange_with_capacity(
        open,
        command,
        input,
        limits,
        current,
        OPENS.get_or_init(|| Arc::new(Semaphore::new(16))).clone(),
    )
    .await
}

async fn exchange_with_capacity(
    open: impl Future<Output = AppResult<Channel<client::Msg>>> + Send + 'static,
    command: String,
    input: Option<String>,
    limits: Limits,
    current: impl Fn() -> AppResult<()>,
    permits: Arc<Semaphore>,
) -> Result<Output, Failure> {
    current()?;
    let permit = permits
        .try_acquire_owned()
        .map_err(|_| AppError::validation("plugin.runners.busy"))?;
    let deadline = tokio::time::Instant::now() + limits.timeout;
    let mut owned = tokio::time::timeout_at(deadline, crate::ssh::channel::open(open, permit))
        .await
        .map_err(|_| Failure::Timeout)??;
    let channel = owned.channel();
    let result = tokio::time::timeout_at(deadline, async {
        current()?;
        channel
            .exec(true, command)
            .await
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        if let Some(input) = input {
            // Queuing EXEC can yield. A cancellation/replacement during that
            // wait must not be followed by a prompt or initialization secrets.
            current()?;
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
    // Best effort only: a closed channel is not proof of remote process exit.
    let _ = tokio::time::timeout(Duration::from_millis(100), channel.close()).await;
    result
}

#[cfg(test)]
mod tests;
