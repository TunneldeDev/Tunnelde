//! Actual worker admission. A cancelled request keeps its slot until IO settles.
use crate::error::{AppError, AppResult};
use std::future::Future;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::Semaphore;

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

struct Pending(Arc<AtomicBool>);
impl Drop for Pending {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

pub(crate) struct Cancellation {
    cancelled: Arc<AtomicBool>,
    error: &'static str,
}
impl Cancellation {
    pub fn check(&self) -> AppResult<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(AppError::validation(self.error))
        } else {
            Ok(())
        }
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
        let pending = Pending(Arc::new(AtomicBool::new(false)));
        let cancellation = Cancellation {
            cancelled: pending.0.clone(),
            error: self.errors.cancelled,
        };
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
        let pending = Pending(Arc::new(AtomicBool::new(false)));
        let cancellation = Cancellation {
            cancelled: pending.0.clone(),
            error: self.errors.cancelled,
        };
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
