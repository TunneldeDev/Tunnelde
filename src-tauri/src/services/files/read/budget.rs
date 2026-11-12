use crate::error::{AppError, AppResult};
use std::future::Future;
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

/// An abandoned caller does not detach the admission permit from real network
/// work. The spawned worker stops at its next cancellation boundary and retains
/// capacity until the current protocol request has settled or closed its channel.
pub(super) async fn run_async<T, F, W>(operation: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(Cancellation) -> W + Send + 'static,
    W: Future<Output = AppResult<T>> + Send + 'static,
{
    run_async_with(CAPACITY.clone(), operation).await
}

async fn run_async_with<T, F, W>(capacity: Arc<Semaphore>, operation: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(Cancellation) -> W + Send + 'static,
    W: Future<Output = AppResult<T>> + Send + 'static,
{
    let permit = capacity
        .try_acquire_owned()
        .map_err(|_| AppError::validation("fileRead.busy"))?;
    let pending = Pending(Arc::new(AtomicBool::new(false)));
    let cancelled = pending.0.clone();
    let result = tokio::spawn(async move {
        let _permit = permit;
        let cancellation = Cancellation(cancelled);
        cancellation.check()?;
        operation(cancellation).await
    })
    .await
    .map_err(|error| worker_error(error, "async-worker"))?;
    drop(pending);
    result
}

fn worker_error(error: tokio::task::JoinError, stage: &'static str) -> AppError {
    tracing::error!(
        target: "files.read",
        stage,
        panic = error.is_panic(),
        cancelled = error.is_cancelled(),
        "File reader worker stopped"
    );
    AppError::internal("fileRead.workerFailed")
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
    .map_err(|error| worker_error(error, "blocking-worker"))?;
    drop(pending);
    result
}

#[cfg(test)]
mod tests;
