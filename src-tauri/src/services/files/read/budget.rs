use crate::error::AppResult;
use crate::services::files::operations::{Budget, Errors};
use std::future::Future;
use std::sync::LazyLock;

pub(super) use crate::services::files::operations::Cancellation;

const ERRORS: Errors = Errors {
    domain: "read",
    busy: "fileRead.busy",
    cancelled: "fileRead.cancelled",
    failed: "fileRead.workerFailed",
};
static CAPACITY: LazyLock<Budget> = LazyLock::new(|| Budget::new(8, ERRORS));

pub(super) async fn run<T: Send + 'static>(
    operation: impl FnOnce(&Cancellation) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    CAPACITY.blocking(operation).await
}

pub(super) async fn run_async<T, F, W>(operation: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(Cancellation) -> W + Send + 'static,
    W: Future<Output = AppResult<T>> + Send + 'static,
{
    CAPACITY.asynchronous(operation).await
}

#[cfg(test)]
async fn run_with<T: Send + 'static>(
    capacity: std::sync::Arc<tokio::sync::Semaphore>,
    operation: impl FnOnce(&Cancellation) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    Budget::with_capacity(capacity, ERRORS)
        .blocking(operation)
        .await
}

#[cfg(test)]
async fn run_async_with<T, F, W>(
    capacity: std::sync::Arc<tokio::sync::Semaphore>,
    operation: F,
) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(Cancellation) -> W + Send + 'static,
    W: Future<Output = AppResult<T>> + Send + 'static,
{
    Budget::with_capacity(capacity, ERRORS)
        .asynchronous(operation)
        .await
}

#[cfg(test)]
mod tests;
