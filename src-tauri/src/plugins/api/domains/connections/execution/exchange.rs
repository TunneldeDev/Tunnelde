//! Pending and confirmed channels remain bounded and owned after caller retirement.
use crate::error::{AppError, AppResult};
use crate::plugins::api::MAX_PAYLOAD;
use russh::{client, ChannelMsg};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

pub(super) async fn run<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    command: String,
    open_budget: Duration,
    execution_budget: Duration,
    mut current: impl FnMut() -> AppResult<()>,
    capacity: Arc<Semaphore>,
) -> AppResult<Value> {
    current()?;
    let permit = capacity
        .try_acquire_owned()
        .map_err(|_| AppError::validation("plugin.api.busy"))?;
    let mut owned = tokio::time::timeout(
        open_budget,
        crate::ssh::channel::open(
            async move {
                handle
                    .channel_open_session()
                    .await
                    .map_err(|error| AppError::Ssh(format!("plugin.exec.channel:{error}")))
            },
            permit,
        ),
    )
    .await
    .map_err(|_| AppError::validation("plugin.api.execTimeout"))??;
    let channel = owned.channel();
    let result = tokio::time::timeout(execution_budget, async {
        current()?;
        channel
            .exec(true, command)
            .await
            .map_err(|error| AppError::Ssh(format!("plugin.exec:{error}")))?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;
        let mut signal = None;
        let mut authority = tokio::time::interval(Duration::from_millis(250));
        loop {
            tokio::select! {
                biased;
                _ = authority.tick() => current()?,
                message = channel.wait() => match message {
                    Some(ChannelMsg::Data { data }) => {
                        check_size(stdout.len(), stderr.len(), data.len())?;
                        stdout.extend_from_slice(&data);
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        check_size(stdout.len(), stderr.len(), data.len())?;
                        stderr.extend_from_slice(&data);
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                    Some(ChannelMsg::ExitSignal { signal_name, .. }) => signal = Some(format!("{signal_name:?}")),
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
            }
        }
        Ok(json!({"stdout":String::from_utf8_lossy(&stdout),"stderr":String::from_utf8_lossy(&stderr),"exitCode":exit_code,"signal":signal}))
    })
    .await
    .unwrap_or_else(|_| Err(AppError::validation("plugin.api.execTimeout")));
    // Shared owner also covers cancellation during this bounded close attempt.
    let _ = tokio::time::timeout(Duration::from_millis(100), channel.close()).await;
    result
}

fn check_size(stdout: usize, stderr: usize, incoming: usize) -> AppResult<()> {
    if incoming > MAX_PAYLOAD.saturating_sub(stdout.saturating_add(stderr)) {
        Err(AppError::validation("plugin.api.outputTooLarge"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
