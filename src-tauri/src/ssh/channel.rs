//! Own confirmed and pending channels across cancellation without owning a session.
use crate::error::{AppError, AppResult};
use russh::{client, Channel, ChannelReadHalf, ChannelStream, ChannelWriteHalf};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::sync::{oneshot, OwnedSemaphorePermit};

pub(crate) struct OwnedChannel {
    channel: Option<Channel<client::Msg>>,
    permit: Option<OwnedSemaphorePermit>,
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

    /// Transfer the same admission slot into a long-lived SFTP reader.
    pub(crate) fn into_stream_with_permit(
        mut self,
    ) -> (ChannelStream<client::Msg>, OwnedSemaphorePermit) {
        let stream = self
            .channel
            .take()
            .expect("owned SSH channel")
            .into_stream();
        let permit = self.permit.take().expect("owned SSH channel capacity");
        (stream, permit)
    }

    pub(crate) fn split(mut self) -> SplitChannel {
        let (reader, writer) = self.channel.take().expect("owned SSH channel").split();
        SplitChannel {
            reader,
            writer: Arc::new(writer),
            permit: self.permit.take(),
        }
    }
}

/// Keep close-on-drop ownership after giving an input task its write handle.
pub(crate) struct SplitChannel {
    reader: ChannelReadHalf,
    writer: Arc<ChannelWriteHalf<client::Msg>>,
    permit: Option<OwnedSemaphorePermit>,
}

impl SplitChannel {
    pub(crate) fn parts(&mut self) -> (&mut ChannelReadHalf, Arc<ChannelWriteHalf<client::Msg>>) {
        (&mut self.reader, self.writer.clone())
    }
}

impl Drop for SplitChannel {
    fn drop(&mut self) {
        let writer = self.writer.clone();
        let permit = self.permit.take();
        tokio::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_millis(100), writer.close()).await;
            drop(permit);
        });
    }
}

impl Drop for OwnedChannel {
    fn drop(&mut self) {
        // Plain russh Channels do not close on drop. Avoid its stream wrapper's
        // unbounded background send: keep capacity through our bounded attempt.
        if let Some(channel) = self.channel.take() {
            let permit = self.permit.take();
            tokio::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_millis(100), channel.close()).await;
                drop(permit);
            });
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
            permit: Some(permit),
        });
        let _ = sender.send(result);
    });
    receiver
        .await
        .map_err(|_| AppError::Ssh("SSH channel owner unavailable".into()))?
}
