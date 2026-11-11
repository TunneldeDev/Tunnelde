//! Dedicated read-only SFTP handles; explicit offsets have no shared cursor.
mod connection;
mod reading;

use crate::error::{AppError, AppResult};
use russh_sftp::client::RawSftpSession;
use std::sync::{Arc, LazyLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

static CONNECTIONS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(64)));

struct Opened {
    raw: RawSftpSession,
    handle: String,
    read_size: usize,
    _permit: OwnedSemaphorePermit,
}

/// Closing this channel never disconnects the user's parent SSH connection.
#[derive(Clone)]
pub struct RemoteReader(Arc<Opened>);

impl RemoteReader {
    pub async fn close(self) {
        // The channel closes even if awaiting CLOSE is cancelled or fails.
        struct Closing<'a>(&'a RawSftpSession);
        impl Drop for Closing<'_> {
            fn drop(&mut self) {
                let _ = self.0.close_session();
            }
        }
        let _closing = Closing(&self.0.raw);
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            self.0.raw.close(self.0.handle.clone()),
        )
        .await;
    }
}

fn invalid_path() -> AppError {
    AppError::validation("fileRead.invalidPath")
}

fn reserve_connection() -> AppResult<OwnedSemaphorePermit> {
    CONNECTIONS
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::validation("fileRead.busy"))
}

fn map_sftp(error: russh_sftp::client::error::Error) -> AppError {
    AppError::Ssh(error.to_string())
}

#[cfg(test)]
mod tests;
