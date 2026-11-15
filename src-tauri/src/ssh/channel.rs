//! Own confirmed and pending channels across cancellation without owning a session.
use crate::error::{AppError, AppResult};
use russh::{client, Channel, ChannelStream};
use std::future::Future;
use tokio::sync::{oneshot, OwnedSemaphorePermit};

pub(crate) struct OwnedChannel {
    channel: Option<Channel<client::Msg>>,
    _permit: OwnedSemaphorePermit,
}

impl OwnedChannel {
    pub(crate) fn channel(&mut self) -> &mut Channel<client::Msg> {
        self.channel.as_mut().expect("owned SSH channel")
    }

    pub(crate) fn into_stream(mut self) -> ChannelStream<client::Msg> {
        self.channel
            .take()
            .expect("owned SSH channel")
            .into_stream()
    }
}

impl Drop for OwnedChannel {
    fn drop(&mut self) {
        // A plain russh Channel does not close on drop; its stream wrapper does.
        if let Some(channel) = self.channel.take() {
            drop(channel.into_stream());
        }
    }
}

pub(crate) async fn open(
    request: impl Future<Output = AppResult<Channel<client::Msg>>> + Send + 'static,
    permit: OwnedSemaphorePermit,
) -> AppResult<OwnedChannel> {
    let (sender, receiver) = oneshot::channel();
    // A cancelled open future can have already submitted OPEN with an unknown
    // channel ID. Keep a bounded owner until confirmation or session disposal.
    // Sending to a retired caller drops the owner and closes a late channel.
    tokio::spawn(async move {
        let result = request.await.map(|channel| OwnedChannel {
            channel: Some(channel),
            _permit: permit,
        });
        let _ = sender.send(result);
    });
    receiver
        .await
        .map_err(|_| AppError::Ssh("SSH channel owner unavailable".into()))?
}
