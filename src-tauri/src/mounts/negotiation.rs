//! Bounded SFTP negotiation without holding the mount registry lock.
use crate::{
    error::{AppError, AppResult},
    ssh::session::ClientHandler,
};
use russh::{client, Channel, ChannelMsg, ChannelStream};
use std::{sync::Arc, time::Duration};
use tokio::sync::{oneshot, OwnedSemaphorePermit, Semaphore};

const TIMEOUT: Duration = Duration::from_secs(15);

// Plain russh Channels do not send Close on drop. Its stream wrapper does.
// Own the channel from confirmation through every request/reply error and
// cancellation, including a confirmation arriving after the caller timed out.
struct PendingChannel(Option<Channel<client::Msg>>);

impl PendingChannel {
    fn into_stream(mut self) -> ChannelStream<client::Msg> {
        self.0.take().expect("owned SFTP channel").into_stream()
    }
}

impl Drop for PendingChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.0.take() {
            drop(channel.into_stream());
        }
    }
}

async fn open<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    permit: OwnedSemaphorePermit,
) -> AppResult<(PendingChannel, OwnedSemaphorePermit)> {
    let (sender, receiver) = oneshot::channel();
    // Cancelling russh's open future abandons an unknown channel ID. Retain a
    // bounded waiter until confirmation or transport closure; a late confirmed
    // channel is closed by PendingChannel when its receiver has gone away.
    // The permit stays with that waiter; retries cannot accumulate unbounded
    // tasks against a server that never confirms. Explicit session disposal
    // closes the parent transport and settles its outstanding opens.
    tokio::spawn(async move {
        let result = handle
            .channel_open_session()
            .await
            .map(|channel| (PendingChannel(Some(channel)), permit))
            .map_err(|error| AppError::Ssh(error.to_string()));
        let _ = sender.send(result);
    });
    receiver
        .await
        .map_err(|_| AppError::validation("mounts.transportClosed"))?
}

pub(super) async fn prepare(
    handle: Arc<client::Handle<ClientHandler>>,
) -> AppResult<ChannelStream<client::Msg>> {
    static REQUESTS: std::sync::OnceLock<Arc<Semaphore>> = std::sync::OnceLock::new();
    let permits = REQUESTS.get_or_init(|| Arc::new(Semaphore::new(8)));
    prepare_with_budget(handle, permits.clone(), TIMEOUT).await
}

async fn prepare_with_budget<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    permits: Arc<Semaphore>,
    budget: Duration,
) -> AppResult<ChannelStream<client::Msg>> {
    let permit = permits
        .try_acquire_owned()
        .map_err(|_| AppError::validation("mounts.connectionBusy"))?;
    tokio::time::timeout(budget, async {
        let (mut pending, _permit) = open(handle, permit).await?;
        let channel = pending.0.as_mut().expect("owned SFTP channel");
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        let mut diagnostic_bytes = 0usize;
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(pending.into_stream()),
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
mod tests;
