//! Actual worker admission. A cancelled request keeps its slot until IO settles.
use crate::error::{AppError, AppResult};
use std::future::Future;
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};
use tokio::sync::Semaphore;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy)]
pub(crate) struct Errors {
    pub domain: &'static str,
    pub busy: &'static str,
    pub cancelled: &'static str,
    pub failed: &'static str,
}

pub(crate) struct Budget {
    capacity: Arc<Semaphore>,
    errors: Errors,
}

struct Pending(Arc<AtomicU8>);
impl Drop for Pending {
    fn drop(&mut self) {
        // An admitted publication cannot be undone by cancelling delivery.
        let _ = self
            .0
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire);
    }
}

#[derive(Clone)]
pub(crate) struct Cancellation {
    state: Arc<AtomicU8>, // live=0, publication admitted=1, cancelled=2
    error: &'static str,
}
impl Cancellation {
    fn new(error: &'static str) -> (Self, Pending) {
        let pending = Pending(Arc::new(AtomicU8::new(0)));
        let cancellation = Self {
            state: pending.0.clone(),
            error,
        };
        (cancellation, pending)
    }

    #[cfg(test)]
    pub(crate) fn for_test(error: &'static str) -> (Self, impl Drop) {
        Self::new(error)
    }

    pub fn check(&self) -> AppResult<()> {
        if self.state.load(Ordering::Acquire) == 2 {
            Err(AppError::validation(self.error))
        } else {
            Ok(())
        }
    }

    /// One winner between cancellation and publication admission. The worker
    /// still owns capacity until the admitted operation and cleanup settle.
    pub fn commit(&self) -> AppResult<()> {
        self.state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| AppError::validation(self.error))
    }
}

impl Budget {
    pub fn new(capacity: usize, errors: Errors) -> Self {
        Self {
            capacity: Arc::new(Semaphore::new(capacity)),
            errors,
        }
    }

    #[cfg(test)]
    pub fn with_capacity(capacity: Arc<Semaphore>, errors: Errors) -> Self {
        Self { capacity, errors }
    }

    pub async fn blocking<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&Cancellation) -> AppResult<T> + Send + 'static,
    ) -> AppResult<T> {
        let permit = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError::validation(self.errors.busy))?;
        let (cancellation, pending) = Cancellation::new(self.errors.cancelled);
        let result = tokio::task::spawn_blocking(move || {
            // The worker owns the slot even while queued in the blocking pool.
            let _permit = permit;
            cancellation.check()?;
            operation(&cancellation)
        })
        .await
        .map_err(|error| self.worker_error(error, "blocking-worker"))?;
        drop(pending);
        result
    }

    pub async fn asynchronous<T, F, W>(&self, operation: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(Cancellation) -> W + Send + 'static,
        W: Future<Output = AppResult<T>> + Send + 'static,
    {
        let permit = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError::validation(self.errors.busy))?;
        let (cancellation, pending) = Cancellation::new(self.errors.cancelled);
        let result = tokio::spawn(async move {
            let _permit = permit;
            cancellation.check()?;
            operation(cancellation).await
        })
        .await
        .map_err(|error| self.worker_error(error, "async-worker"))?;
        drop(pending);
        result
    }

    fn worker_error(&self, error: tokio::task::JoinError, stage: &'static str) -> AppError {
        tracing::error!(
            target: "files.operations",
            domain = self.errors.domain,
            stage,
            panic = error.is_panic(),
            cancelled = error.is_cancelled(),
            "File operation worker stopped"
        );
        AppError::internal(self.errors.failed)
    }
}
