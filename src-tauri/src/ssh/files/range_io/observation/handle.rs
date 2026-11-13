//! Bind each writable OPEN to its own original CLOSE, independent of handle bytes.
use super::*;
use crate::ssh::files::native_save::runtime::MutationReceipt;
use std::{ops::Deref, sync::Mutex};

#[derive(Clone)]
pub(in super::super) struct Handle {
    name: String,
    owner: Option<Arc<Writable>>,
}

struct Writable {
    raw: Arc<RawSftpSession>,
    observation: MutationObservation,
    name: String,
    receipt: Mutex<Option<MutationReceipt>>,
}

impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Handle")
            .field("writable", &self.owner.is_some())
            .finish_non_exhaustive()
    }
}

impl Deref for Handle {
    type Target = str;
    fn deref(&self) -> &str {
        &self.name
    }
}

impl Handle {
    pub(in super::super) fn unowned(name: String) -> Self {
        Self { name, owner: None }
    }

    pub(super) fn writable(
        name: String,
        raw: Arc<RawSftpSession>,
        observation: MutationObservation,
        receipt: MutationReceipt,
    ) -> Self {
        Self {
            name: name.clone(),
            owner: Some(Arc::new(Writable {
                raw,
                observation,
                name,
                receipt: Mutex::new(Some(receipt)),
            })),
        }
    }

    pub(in super::super) async fn close(&self, raw: Arc<RawSftpSession>) -> AppResult<()> {
        let Some(owner) = &self.owner else {
            return raw.close(&self.name).await.map_err(map_sftp).map(|_| ());
        };
        if !Arc::ptr_eq(&raw, &owner.raw) {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        let receipt = owner
            .receipt
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| AppError::validation("editor.remoteOutcomeUnknown"))?;
        owner
            .finish(receipt)
            .await
            .map_err(|error| AppError::internal(format!("SFTP CLOSE worker: {error}")))?
    }
}

impl Writable {
    fn finish(&self, receipt: MutationReceipt) -> tauri::async_runtime::JoinHandle<AppResult<()>> {
        let raw = self.raw.clone();
        let name = self.name.clone();
        let observation = self.observation.clone();
        // No fresh permission is needed to finish an already admitted handle.
        // Caller timeout drops its wait, never this original response observer.
        tauri::async_runtime::spawn(async move {
            observation
                .request_completion(raw.close(name))
                .await
                .map_err(map_sftp)?;
            receipt.acknowledge();
            Ok(())
        })
    }
}

impl Drop for Writable {
    fn drop(&mut self) {
        if let Some(receipt) = self.receipt.get_mut().unwrap().take() {
            // An OPEN whose result was abandoned must still get its own CLOSE.
            // Failure leaves the original receipt outstanding; never resend it.
            let completion = self.finish(receipt);
            tauri::async_runtime::spawn(async move {
                if let Ok(Err(error)) = completion.await {
                    tracing::warn!(target: "files.transfer", %error, "Abandoned writable OPEN could not close");
                }
            });
        }
    }
}
