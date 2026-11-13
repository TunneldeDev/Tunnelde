//! Original request completion evidence; never reconstructed from an AppError.
mod authorization;
#[cfg(test)]
mod tests;
use crate::error::{AppError, AppResult};
use authorization::Authorization;
use russh_sftp::{client::error::Error, protocol::StatusCode};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

#[derive(Clone, Default)]
pub(crate) struct Observation(Arc<AtomicUsize>, Option<Authorization>);

const SEALED: usize = 1 << (usize::BITS - 1);

/// Original protocol worker only. Dropping a receipt deliberately retains its
/// outstanding count: shutdown or caller loss is not a terminal peer reply.
pub(crate) struct Receipt {
    pending: Arc<AtomicUsize>,
}

enum RequestFailure {
    Admission(AppError),
    Protocol(Error),
}

impl Receipt {
    pub(crate) fn acknowledge(self) {
        self.pending.fetch_sub(1, Ordering::AcqRel);
    }

    fn finish<T>(self, result: Result<T, Error>) -> Result<T, Error> {
        let acknowledged = match &result {
            Ok(_) => true,
            Err(Error::Status(status)) => terminal(status),
            Err(_) => false,
        };
        if acknowledged {
            self.acknowledge();
        }
        result
    }
}

impl Observation {
    /// Preserve the original epoch while checking live authority at each send.
    pub(crate) fn guarded(
        &self,
        validate: impl Fn() -> AppResult<()> + Send + Sync + 'static,
    ) -> Self {
        let previous = self.1.clone();
        Self(
            self.0.clone(),
            Some(Authorization::new(move || {
                if let Some(previous) = &previous {
                    previous.check()?;
                }
                validate()
            })),
        )
    }

    pub(crate) fn authorize(&self) -> AppResult<()> {
        self.1.as_ref().map_or(Ok(()), Authorization::check)
    }

    pub(crate) fn begin(&self) -> Option<Receipt> {
        let mut pending = self.0.load(Ordering::Acquire);
        loop {
            let next = pending.checked_add(1).filter(|next| *next < SEALED)?;
            match self
                .0
                .compare_exchange_weak(pending, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => {
                    return Some(Receipt {
                        pending: self.0.clone(),
                    });
                }
                Err(current) => pending = current,
            }
        }
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
        self.authorize().map_err(authorization::protocol)?;
        self.request_completion(request).await
    }

    /// Only completion of a previously admitted handle, such as CLOSE. Live
    /// revocation must stop new writes without abandoning their original reply.
    pub(crate) async fn request_completion<T>(
        &self,
        request: impl Future<Output = Result<T, Error>>,
    ) -> Result<T, Error> {
        let receipt = self
            .begin()
            .ok_or_else(|| Error::IO("Mutation request admission is closed".into()))?;
        receipt.finish(request.await)
    }

    /// Caller cancellation drops only the wait. The original worker owns its
    /// channel and receipt until a typed terminal response or transport failure.
    /// Acquire admission before spawning so queued old work cannot escape a seal.
    pub(crate) async fn retained<T: Send + 'static>(
        &self,
        request: impl Future<Output = Result<T, Error>> + Send + 'static,
    ) -> Result<T, Error> {
        self.retained_result(request)
            .await
            .map_err(|failure| match failure {
                RequestFailure::Admission(error) => authorization::protocol(error),
                RequestFailure::Protocol(error) => error,
            })
    }

    /// Application adapters can preserve typed local cancellation/admission
    /// errors instead of wrapping them as if the peer had rejected a request.
    pub(crate) async fn retained_checked<T: Send + 'static>(
        &self,
        request: impl Future<Output = Result<T, Error>> + Send + 'static,
        map: impl FnOnce(Error) -> AppError,
    ) -> AppResult<T> {
        self.retained_result(request)
            .await
            .map_err(|failure| match failure {
                RequestFailure::Admission(error) => error,
                RequestFailure::Protocol(error) => map(error),
            })
    }

    async fn retained_result<T: Send + 'static>(
        &self,
        request: impl Future<Output = Result<T, Error>> + Send + 'static,
    ) -> Result<T, RequestFailure> {
        self.authorize().map_err(RequestFailure::Admission)?;
        let receipt = self.begin().ok_or_else(|| {
            RequestFailure::Admission(AppError::validation("editor.remoteOutcomeUnknown"))
        })?;
        let observation = self.clone();
        let worker = tauri::async_runtime::spawn(async move {
            // The runtime queue may outlive the caller's original approval.
            if let Err(error) = observation.authorize() {
                receipt.acknowledge(); // Definitely unsent; no request polled.
                return Err(RequestFailure::Admission(error));
            }
            receipt
                .finish(request.await)
                .map_err(RequestFailure::Protocol)
        });
        worker.await.map_err(|error| {
            RequestFailure::Protocol(Error::IO(format!("Mutation response worker: {error}")))
        })?
    }

    /// Composite/exec adapters without typed per-request replies remain
    /// conservative on error. This must enclose the entire uninstrumented work.
    pub(crate) async fn opaque<T>(&self, work: impl Future<Output = AppResult<T>>) -> AppResult<T> {
        self.authorize()?;
        self.completion(work).await
    }

    pub(crate) async fn completion<T>(
        &self,
        work: impl Future<Output = AppResult<T>>,
    ) -> AppResult<T> {
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

    pub(crate) fn closed(&self) -> bool {
        self.0.load(Ordering::Acquire) == SEALED
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
