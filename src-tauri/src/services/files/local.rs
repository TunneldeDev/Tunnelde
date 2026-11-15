//! Bounded native local-file operations. Synchronous filesystem semantics remain shared.
use crate::error::AppResult;
use crate::services::operations::{Budget, Errors};
use crate::ssh::files::{self, Listing};
use std::sync::LazyLock;

// A recursive deletion can retain a worker for the duration of the real IO.
// Bound queued and running requests instead of accumulating blocking tasks.
static WORKERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(8, ERRORS));
const ERRORS: Errors = Errors {
    domain: "local-files",
    busy: "sftp.localBusy",
    cancelled: "sftp.localCancelled",
    failed: "sftp.localWorkerFailed",
};

async fn run<T: Send + 'static>(
    budget: &Budget,
    operation: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    budget
        .blocking(move |job| {
            // Cancellation may prevent queued work, but cannot roll back an
            // admitted filesystem operation or release its actual worker slot.
            job.commit()?;
            operation()
        })
        .await
}

pub(crate) async fn list(path: Option<String>) -> AppResult<Listing> {
    run(&WORKERS, move || files::local_list(path)).await
}

pub(crate) async fn mkdir(path: String) -> AppResult<()> {
    run(&WORKERS, move || files::local_mkdir(path)).await
}

pub(crate) async fn create_file(path: String) -> AppResult<()> {
    run(&WORKERS, move || files::local_create_file(path)).await
}

pub(crate) async fn delete(path: String, is_dir: bool) -> AppResult<()> {
    run(&WORKERS, move || files::local_delete(path, is_dir)).await
}

#[cfg(test)]
mod tests;
