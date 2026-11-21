//! Bounded SFTP negotiation without holding the mount registry lock.
use crate::{
    error::{AppError, AppResult},
    ssh::session::ClientHandler,
};
#[cfg(test)]
use russh::ChannelStream;
use russh::{client, ChannelMsg};
use std::{sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const TIMEOUT: Duration = Duration::from_secs(15);

async fn open<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    permit: OwnedSemaphorePermit,
) -> AppResult<crate::ssh::channel::OwnedChannel> {
    crate::ssh::channel::open(
        async move {
            handle
                .channel_open_session()
                .await
                .map_err(|error| AppError::Ssh(error.to_string()))
        },
        permit,
    )
    .await
}

pub(super) async fn prepare_owned(
    handle: Arc<client::Handle<ClientHandler>>,
) -> AppResult<crate::ssh::channel::OwnedChannel> {
    static REQUESTS: std::sync::OnceLock<Arc<Semaphore>> = std::sync::OnceLock::new();
    let permits = REQUESTS.get_or_init(|| Arc::new(Semaphore::new(8)));
    prepare_owned_with_budget(handle, permits.clone(), TIMEOUT).await
}

async fn prepare_owned_with_budget<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    permits: Arc<Semaphore>,
    budget: Duration,
) -> AppResult<crate::ssh::channel::OwnedChannel> {
    let permit = permits
        .try_acquire_owned()
        .map_err(|_| AppError::validation("mounts.connectionBusy"))?;
    tokio::time::timeout(budget, async {
        let mut pending = open(handle, permit).await?;
        let channel = pending.channel();
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        let mut diagnostic_bytes = 0usize;
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(pending),
                Some(ChannelMsg::Failure) => {
                    return Err(AppError::validation("mounts.subsystemRejected"));
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    diagnostic_bytes = diagnostic_bytes.saturating_add(data.len());
                    if diagnostic_bytes > 16 * 1024 {
                        return Err(AppError::validation("mounts.subsystemProtocol"));
                    }
                }
                // SFTP starts with the client's INIT, sent only after success.
                // Reject premature protocol bytes rather than silently lose them.
                Some(ChannelMsg::Data { .. }) => {
                    return Err(AppError::validation("mounts.subsystemProtocol"));
                }
                Some(ChannelMsg::Eof | ChannelMsg::Close | ChannelMsg::ExitStatus { .. })
                | None => return Err(AppError::validation("mounts.transportClosed")),
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| AppError::validation("mounts.negotiationTimeout"))?
}

#[cfg(test)]
async fn prepare_with_budget<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    permits: Arc<Semaphore>,
    budget: Duration,
) -> AppResult<ChannelStream<client::Msg>> {
    Ok(prepare_owned_with_budget(handle, permits, budget)
        .await?
        .into_stream())
}

#[cfg(test)]
mod tests;
