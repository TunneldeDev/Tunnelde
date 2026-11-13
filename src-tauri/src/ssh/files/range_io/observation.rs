//! Raw SFTP completion and writable-handle ownership on the actual data channel.
use super::*;
use crate::ssh::files::native_save::runtime::{
    terminal_mutation_status, MutationObservation, MutationReceipt,
};
use russh_sftp::client::error::Error;
use std::{collections::HashMap, future::Future, sync::Mutex};

pub(super) struct Writes {
    requests: MutationObservation,
    handles: Mutex<HashMap<String, MutationReceipt>>,
}

impl Writes {
    pub(super) fn new(requests: MutationObservation) -> Self {
        Self {
            requests,
            handles: Mutex::new(HashMap::new()),
        }
    }

    pub(super) async fn request<T>(
        &self,
        work: impl Future<Output = Result<T, Error>>,
    ) -> Result<T, Error> {
        self.requests.request(work).await
    }

    pub(super) async fn open(
        &self,
        work: impl Future<Output = Result<russh_sftp::protocol::Handle, Error>>,
    ) -> AppResult<String> {
        let receipt = self
            .requests
            .begin()
            .ok_or_else(|| AppError::validation("editor.remoteOutcomeUnknown"))?;
        match work.await {
            Ok(reply) => {
                let mut handles = self.handles.lock().unwrap();
                // A server may reuse a handle after processing a CLOSE whose
                // reply our caller dropped. Replacing this map entry drops the
                // old receipt without acknowledging it, so later CLOSE can
                // settle only this newly observed OPEN, never the earlier one.
                handles.insert(reply.handle.clone(), receipt);
                Ok(reply.handle)
            }
            Err(error) => {
                if matches!(&error, Error::Status(status) if terminal_mutation_status(status)) {
                    receipt.acknowledge();
                }
                Err(map_sftp(error))
            }
        }
    }

    pub(super) async fn close(&self, raw: &RawSftpSession, handle: &str) -> AppResult<()> {
        // Move the exact OPEN receipt into its original CLOSE future. A new
        // OPEN may reuse the same bytes while this reply is delayed, so looking
        // up by handle after await could accidentally retire the new writer.
        let writing = self.handles.lock().unwrap().remove(handle);
        if let Some(receipt) = writing {
            self.request(raw.close(handle)).await.map_err(map_sftp)?;
            receipt.acknowledge();
        } else {
            raw.close(handle).await.map_err(map_sftp)?;
        }
        Ok(())
    }
}
