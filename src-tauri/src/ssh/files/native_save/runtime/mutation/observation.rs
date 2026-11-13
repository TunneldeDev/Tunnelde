//! Original request completion evidence; never reconstructed from an AppError.
#[cfg(test)]
mod tests;
use crate::error::{AppError, AppResult};
use russh_sftp::{client::error::Error, protocol::StatusCode};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

#[derive(Clone, Default)]
pub(crate) struct Observation(Arc<AtomicUsize>);

const SEALED: usize = 1 << (usize::BITS - 1);

/// Original protocol worker only. Dropping a receipt deliberately retains its
/// outstanding count: shutdown or caller loss is not a terminal peer reply.
pub(crate) struct Receipt {
    pending: Arc<AtomicUsize>,
}

impl Receipt {
    pub(crate) fn acknowledge(self) {
        self.pending.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Observation {
    pub(crate) fn begin(&self) -> Option<Receipt> {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |pending| {
                pending.checked_add(1).filter(|next| *next < SEALED)
            })
            .ok()
            .map(|_| Receipt {
                pending: self.0.clone(),
            })
    }

    /// The final worker closes admission only when every original request and
    /// writable handle is settled. Queued adapters sharing an older clone can
    /// no longer submit a mutation after the durable claim is parked/released.
    pub(crate) fn seal(&self) -> AppResult<()> {
        self.0
            .compare_exchange(0, SEALED, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| AppError::validation("editor.remoteOutcomeUnknown"))
    }

    /// Every request owns its own outstanding count. A later successful request
    /// cannot acknowledge an earlier timeout, dropped future or lost response.
    pub(crate) async fn request<T>(
        &self,
        request: impl Future<Output = Result<T, Error>>,
    ) -> Result<T, Error> {
        let receipt = self
            .begin()
            .ok_or_else(|| Error::IO("Mutation request admission is closed".into()))?;
        let result = request.await;
        let acknowledged = match &result {
            Ok(_) => true,
            Err(Error::Status(status)) => terminal(status),
            Err(_) => false,
        };
        if acknowledged {
            receipt.acknowledge();
        }
        result
    }

    /// Composite/exec adapters without typed per-request replies remain
    /// conservative on error. This must enclose the entire uninstrumented work.
    pub(crate) async fn opaque<T>(&self, work: impl Future<Output = AppResult<T>>) -> AppResult<T> {
        let receipt = self
            .begin()
            .ok_or_else(|| AppError::validation("editor.remoteOutcomeUnknown"))?;
        let result = work.await;
        if result.is_ok() {
            receipt.acknowledge();
        }
        result
    }

    pub(crate) fn settled(&self) -> bool {
        matches!(self.0.load(Ordering::Acquire), 0 | SEALED)
    }
}

pub(crate) fn terminal(status: &russh_sftp::protocol::Status) -> bool {
    // Only protocol-defined terminal rejections from the original response.
    // Pseudo connection statuses and malformed/unexpected packets prove nothing.
    matches!(
        status.status_code,
        StatusCode::NoSuchFile
            | StatusCode::PermissionDenied
            | StatusCode::Failure
            | StatusCode::OpUnsupported
    )
}
