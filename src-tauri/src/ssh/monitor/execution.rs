//! Sampling owns its channel through timeout and caller retirement.
use crate::error::{AppError, AppResult};
use russh::{client, ChannelMsg};
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

pub(super) async fn run<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    command: String,
    deadline: Duration,
    capacity: Arc<Semaphore>,
) -> AppResult<String> {
    let collect = async {
        // Waiting for a slot uses the existing overall sample deadline. A timed
        // out caller cannot submit a later OPEN after another sample finishes.
        let permit = capacity
            .acquire_owned()
            .await
            .map_err(|_| AppError::Ssh("monitor.timeout".into()))?;
        let mut owned = crate::ssh::channel::open(
            async move {
                handle
                    .channel_open_session()
                    .await
                    .map_err(|error| AppError::Ssh(format!("monitor.channel: {error}")))
            },
            permit,
        )
        .await?;
        let channel = owned.channel();
        channel
            .exec(true, command)
            .await
            .map_err(|error| AppError::Ssh(format!("monitor.exec: {error}")))?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if data.len() > (8 * 1024 * 1024_usize).saturating_sub(output.len()) {
                        return Err(AppError::Ssh("monitor.outputLimit".into()));
                    }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(String::from_utf8_lossy(&output).into_owned())
    };
    tokio::time::timeout(deadline, collect)
        .await
        .map_err(|_| AppError::Ssh("monitor.timeout".into()))?
}

#[cfg(test)]
mod tests;
