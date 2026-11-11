use crate::error::{AppError, AppResult};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, LazyLock,
};
use tokio::sync::Semaphore;

static CAPACITY: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(8)));

struct Pending(Arc<AtomicBool>);
impl Drop for Pending {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

pub(super) struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn check(&self) -> AppResult<()> {
        if self.0.load(Ordering::Acquire) {
            Err(AppError::validation("fileRead.cancelled"))
        } else {
            Ok(())
        }
    }
}

pub(super) async fn run<T: Send + 'static>(
    operation: impl FnOnce(&Cancellation) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    run_with(CAPACITY.clone(), operation).await
}

async fn run_with<T: Send + 'static>(
    capacity: Arc<Semaphore>,
    operation: impl FnOnce(&Cancellation) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let permit = capacity
        .try_acquire_owned()
        .map_err(|_| AppError::validation("fileRead.busy"))?;
    let pending = Pending(Arc::new(AtomicBool::new(false)));
    let cancelled = pending.0.clone();
    let result = tokio::task::spawn_blocking(move || {
        // This permit belongs to the worker, including while queued or when its
        // async caller is dropped. A timeout cannot free an occupied IO slot.
        let _permit = permit;
        let cancellation = Cancellation(cancelled);
        cancellation.check()?;
        operation(&cancellation)
    })
    .await
    .map_err(|error| {
        tracing::error!(
            target: "files.read",
            stage = "blocking-worker",
            panic = error.is_panic(),
            cancelled = error.is_cancelled(),
            "Local file reader worker stopped"
        );
        AppError::internal("fileRead.workerFailed")
    })?;
    drop(pending);
    result
}

#[cfg(test)]
mod tests;
