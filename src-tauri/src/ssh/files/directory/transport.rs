//! Track russh-sftp's hidden reader/writer tasks by ownership of their stream.
//! Closing its API only queues a sentinel; it is not proof the tasks settled.
use super::*;
use std::{
    pin::Pin,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf},
    sync::oneshot,
    task::JoinHandle,
};

struct Tracked {
    stream: DuplexStream,
    dropped: Option<oneshot::Sender<()>>,
    _lifetime: WorkLifetime,
}
impl Drop for Tracked {
    fn drop(&mut self) {
        if let Some(done) = self.dropped.take() {
            let _ = done.send(());
        }
    }
}
impl AsyncRead for Tracked {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}
impl AsyncWrite for Tracked {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
pub(super) struct Session {
    pub raw: RawSftpSession,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
    dropped: oneshot::Receiver<()>,
}
impl Session {
    pub fn new(channel: crate::ssh::channel::SplitChannel) -> Self {
        let lifetime = WorkLifetime::current();
        let (client, wire) = tokio::io::duplex(64 * 1024);
        let (dropped, wait) = oneshot::channel();
        let raw = RawSftpSession::new_with_config(
            Tracked {
                stream: client,
                dropped: Some(dropped),
                _lifetime: lifetime.clone(),
            },
            russh_sftp::client::Config {
                max_packet_len: 256 * 1024,
                request_timeout_secs: 15,
                ..Default::default()
            },
        );
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(lifetime.scope(bridge(channel, wire, stopped)));
        Self {
            raw,
            stop: Some(stop),
            task,
            dropped: wait,
        }
    }
    pub async fn finish(mut self) {
        let _ = self.raw.close_session();
        self.stop.take(); // Also wakes bridge if the caller was cancelled.
        let _ = (&mut self.task).await;
        // Both hidden library halves must release the actual stream. No fixed
        // sleep, timeout or kill-on-drop assertion stands in for this signal.
        let _ = (&mut self.dropped).await;
    }
}
// Drop closes both raw and stop sender. The detached bridge still owns its
// channel, slot and inherited lifetime; the library stream carries it too.
async fn bridge(
    mut channel: crate::ssh::channel::SplitChannel,
    mut wire: DuplexStream,
    mut stopped: oneshot::Receiver<()>,
) {
    {
        let (reader, writer) = channel.parts();
        let (mut input, mut output) = tokio::io::split(&mut wire);
        let copy = async {
            tokio::try_join!(
                async {
                    let mut buf = [0u8; 32 * 1024];
                    loop {
                        let size = input.read(&mut buf).await?;
                        if size == 0 {
                            return Ok::<_, std::io::Error>(());
                        }
                        writer
                            .data(&buf[..size])
                            .await
                            .map_err(std::io::Error::other)?;
                    }
                },
                async {
                    let mut diagnostics = 0usize;
                    while let Some(message) = reader.wait().await {
                        match message {
                            ChannelMsg::Data { data } => output.write_all(&data).await?,
                            ChannelMsg::ExtendedData { data, .. } => {
                                diagnostics = diagnostics.saturating_add(data.len());
                                if diagnostics > 16 * 1024 {
                                    return Err(std::io::Error::other("SFTP diagnostic limit"));
                                }
                            }
                            ChannelMsg::Eof | ChannelMsg::Close => return Ok(()),
                            _ => {}
                        }
                    }
                    Ok(())
                }
            )?;
            Ok::<_, std::io::Error>(())
        };
        tokio::select! { _ = &mut stopped => {}, _ = copy => {} }
    }
    drop(wire); // Force blocked SFTP library halves to settle before releasing fence.
    channel.finish().await;
}
