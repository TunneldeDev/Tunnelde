//! Original raw SFTP workers retain their channel and completion after cancellation.
mod handle;
use super::*;
use crate::ssh::files::native_save::runtime::{terminal_mutation_status, MutationObservation};
pub(super) use handle::Handle;
use russh_sftp::client::error::Error;
use std::future::Future;

pub(super) struct Writes {
    requests: MutationObservation,
}

impl Writes {
    pub(super) fn new(requests: MutationObservation) -> Self {
        Self { requests }
    }

    pub(super) async fn request<T: Send + 'static>(
        &self,
        work: impl Future<Output = Result<T, Error>> + Send + 'static,
    ) -> AppResult<T> {
        self.requests.retained_checked(work, map_sftp).await
    }

    pub(super) async fn open(&self, raw: Arc<RawSftpSession>, path: String) -> AppResult<Handle> {
        self.requests.authorize()?;
        let receipt = self
            .requests
            .begin()
            .ok_or_else(|| AppError::validation("editor.remoteOutcomeUnknown"))?;
        let observation = self.requests.clone();
        // The returned Handle also owns abandoned delivery: if cancellation
        // drops the successful result, its destructor closes this exact OPEN.
        tauri::async_runtime::spawn(async move {
            if let Err(error) = observation.authorize() {
                receipt.acknowledge(); // Definitely unsent.
                return Err(error);
            }
            match raw
                .open(
                    path,
                    OpenFlags::WRITE,
                    russh_sftp::protocol::FileAttributes::empty(),
                )
                .await
            {
                Ok(reply) => Ok(Handle::writable(reply.handle, raw, observation, receipt)),
                Err(error) => {
                    if matches!(&error, Error::Status(status) if terminal_mutation_status(status)) {
                        receipt.acknowledge();
                    }
                    Err(map_sftp(error))
                }
            }
        })
        .await
        .map_err(|error| AppError::internal(format!("SFTP OPEN worker: {error}")))?
    }
}
