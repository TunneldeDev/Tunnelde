//! Original request completion evidence; never reconstructed from an AppError.
#[cfg(test)]
mod tests;
use crate::error::AppResult;
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
    pub(crate) fn begin(&self) -> Receipt {
        self.0.fetch_add(1, Ordering::AcqRel);
        Receipt {
            pending: self.0.clone(),
        }
    }

    /// Every request owns its own outstanding count. A later successful request
    /// cannot acknowledge an earlier timeout, dropped future or lost response.
    pub(crate) async fn request<T>(
        &self,
        request: impl Future<Output = Result<T, Error>>,
    ) -> Result<T, Error> {
        let receipt = self.begin();
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
        let receipt = self.begin();
        let result = work.await;
        if result.is_ok() {
            receipt.acknowledge();
        }
        result
    }

    pub(crate) fn settled(&self) -> bool {
        self.0.load(Ordering::Acquire) == 0
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
