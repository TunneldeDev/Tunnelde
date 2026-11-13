//! Keep the metadata-channel writable OPEN with its own original CLOSE.
//! Buffered IO errors cannot be reconstructed into typed protocol evidence.
use super::{map_sftp, native_save::runtime, AppResult};
use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

pub(super) struct File {
    inner: russh_sftp::client::fs::File,
    observation: runtime::MutationObservation,
    handle: runtime::MutationReceipt,
}

impl File {
    pub(super) async fn open(
        sftp: &SftpSession,
        path: &str,
        flags: OpenFlags,
        observation: &runtime::MutationObservation,
    ) -> AppResult<Self> {
        // OPEN can create/truncate before its reply is received. Dropping this
        // future must retain uncertainty even if no File reached the caller.
        let handle = observation
            .begin()
            .ok_or_else(|| super::AppError::validation("editor.remoteOutcomeUnknown"))?;
        match sftp.open_with_flags(path, flags).await {
            Ok(inner) => Ok(Self {
                inner,
                observation: observation.clone(),
                handle,
            }),
            Err(error) => {
                if matches!(&error, russh_sftp::client::error::Error::Status(status)
                    if runtime::terminal_mutation_status(status))
                {
                    handle.acknowledge();
                }
                Err(map_sftp(error))
            }
        }
    }

    pub(super) async fn seek(&mut self, position: std::io::SeekFrom) -> AppResult<u64> {
        Ok(self.inner.seek(position).await?)
    }

    pub(super) async fn write_all(&mut self, buffer: &[u8]) -> AppResult<()> {
        self.observation
            .opaque(async {
                self.inner.write_all(buffer).await?;
                Ok(())
            })
            .await
    }

    pub(super) async fn finish(self) -> AppResult<()> {
        let Self {
            mut inner,
            observation,
            handle,
        } = self;
        let flushed = observation
            .opaque(async {
                inner.flush().await?;
                Ok(())
            })
            .await;
        // Attempt CLOSE even when flushing failed. A successful CLOSE retires
        // this handle only; it cannot erase a prior unconfirmed write/flush.
        let closed = observation
            .opaque(async {
                inner.close().await?;
                Ok(())
            })
            .await;
        if closed.is_ok() {
            handle.acknowledge();
        }
        flushed?;
        closed
    }
}
