//! Own confirmed and pending channels across cancellation without owning a session.
use crate::error::{AppError, AppResult};
use russh::{client, Channel, ChannelReadHalf, ChannelStream, ChannelWriteHalf};
use std::{future::Future, sync::Arc};
use tokio::sync::{oneshot, OwnedSemaphorePermit};

pub(crate) struct OwnedChannel {
    channel: Option<Channel<client::Msg>>,
    permit: Option<OwnedSemaphorePermit>,
    lifetime: crate::services::operations::WorkLifetime,
}

impl OwnedChannel {
    pub(crate) fn channel(&mut self) -> &mut Channel<client::Msg> {
        self.channel.as_mut().expect("owned SSH channel")
    }

    #[cfg(test)]
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
            reader: Some(reader),
            writer: Arc::new(writer),
            permit: self.permit.take(),
            lifetime: self.lifetime.clone(),
        }
    }
}

/// Keep close-on-drop ownership after giving an input task its write handle.
pub(crate) struct SplitChannel {
    reader: Option<ChannelReadHalf>,
    writer: Arc<ChannelWriteHalf<client::Msg>>,
    permit: Option<OwnedSemaphorePermit>,
    lifetime: crate::services::operations::WorkLifetime,
}

impl SplitChannel {
    pub(crate) fn parts(&mut self) -> (&mut ChannelReadHalf, Arc<ChannelWriteHalf<client::Msg>>) {
        (
            self.reader.as_mut().expect("owned SSH channel read side"),
            self.writer.clone(),
        )
    }

    /// An accepted host resource may outlive its creating view. Until the host
    /// commits that resource, even a dropped/late channel retains the original
    /// effect. Dropping the release callback does NOT release that fence.
    pub(crate) fn release_work_on_commit(mut self) -> (Self, impl FnOnce()) {
        let retained = Arc::new(std::sync::Mutex::new(Some(self.lifetime.clone())));
        self.lifetime = crate::services::operations::WorkLifetime::new(retained.clone());
        (self, move || {
            retained.lock().unwrap_or_else(|e| e.into_inner()).take();
        })
    }

    /// Retirement survives cancellation of the caller awaiting it. A queued
    /// CLOSE is not settlement; keep the slot/effect until peer ACK or session end.
    pub(crate) async fn finish(mut self) {
        if let Some(task) = self.retire() {
            let _ = task.await;
        }
    }

    fn retire(&mut self) -> Option<tokio::task::JoinHandle<()>> {
        let permit = self.permit.take()?;
        let reader = self.reader.take().expect("owned SSH channel read side");
        let writer = self.writer.clone();
        let lifetime = self.lifetime.clone();
        Some(tokio::spawn(lifetime.scope(async move {
            let _permit = permit;
            let messages = futures_util::stream::unfold(reader, |mut reader| async move {
                reader.wait().await.map(|message| (message, reader))
            });
            drain_close(writer.close(), messages).await;
        })))
    }
}
/// Draining and enqueueing must progress together, including while both bounded
/// queues are full. CLOSE ACK (or receiver/session end) is the retirement proof.
async fn drain_close<E>(
    close: impl Future<Output = Result<(), E>>,
    messages: impl futures_util::Stream<Item = russh::ChannelMsg>,
) {
    use futures_util::{pin_mut, StreamExt};
    pin_mut!(close, messages);
    let mut sent = false;
    loop {
        tokio::select! {
            result = &mut close, if !sent => {
                if result.is_err() { break; }
                sent = true;
            }
            message = messages.next() => {
                if matches!(message, Some(russh::ChannelMsg::Close) | None) { break; }
            }
        }
    }
}

impl Drop for SplitChannel {
    fn drop(&mut self) {
        self.retire();
    }
}
impl Drop for OwnedChannel {
    fn drop(&mut self) {
        // Plain russh Channels do not close on drop. A late OPEN keeps its
        // slot and inherited effect through actual retirement.
        if let Some(channel) = self.channel.take() {
            let (reader, writer) = channel.split();
            drop(SplitChannel {
                reader: Some(reader),
                writer: Arc::new(writer),
                permit: self.permit.take(),
                lifetime: self.lifetime.clone(),
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
    let lifetime = crate::services::operations::WorkLifetime::current();
    tokio::spawn(lifetime.clone().scope(async move {
        let result = request.await.map(|channel| OwnedChannel {
            channel: Some(channel),
            permit: Some(permit),
            lifetime,
        });
        let _ = sender.send(result);
    }));
    receiver
        .await
        .map_err(|_| AppError::Ssh("SSH channel owner unavailable".into()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn retirement_drains_full_read_queue_before_close_enqueue_can_finish() {
        use russh::ChannelMsg;
        let (send, receive) = tokio::sync::mpsc::channel(1);
        send.send(ChannelMsg::Eof).await.unwrap();
        let (closed, wait) = oneshot::channel();
        // Model the SSH event loop blocked forwarding output into a full
        // per-channel read queue before it can process our outgoing CLOSE.
        let session = tokio::spawn(async move {
            send.send(ChannelMsg::Eof).await.unwrap();
            closed.send(()).unwrap();
            send.send(ChannelMsg::Close).await.unwrap();
        });
        let messages = futures_util::stream::unfold(receive, |mut receiver| async move {
            receiver.recv().await.map(|message| (message, receiver))
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            drain_close(wait, messages),
        )
        .await
        .unwrap();
        session.await.unwrap();
    }
}
