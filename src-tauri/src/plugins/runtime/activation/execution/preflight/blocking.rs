//! Cancellation cannot terminate a filesystem read or WASM compilation already
//! running on a blocking thread. The worker owns capacity until it really exits.
use std::sync::{Arc, OnceLock};
use tokio::sync::Semaphore;

use crate::error::{AppError, AppResult};

pub(super) async fn run<T: Send + 'static>(
    operation: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    static CAPACITY: OnceLock<Arc<Semaphore>> = OnceLock::new();
    run_with(
        CAPACITY
            .get_or_init(|| {
                Arc::new(Semaphore::new(
                    crate::plugins::runtime::activation::limits::MAX_BLOCKING_WORKERS,
                ))
            })
            .clone(),
        operation,
    )
    .await
}

async fn run_with<T: Send + 'static>(
    capacity: Arc<Semaphore>,
    operation: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let permit = capacity
        .try_acquire_owned()
        .map_err(|_| AppError::validation("plugin.api.busy"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|_| AppError::internal("plugin.activation.failed"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_waiter_does_not_release_an_unfinished_blocking_workers_slot() {
        let capacity = Arc::new(Semaphore::new(1));
        let (started, waiting) = tokio::sync::oneshot::channel();
        let (release, finish) = std::sync::mpsc::channel();
        let worker_capacity = capacity.clone();
        let task = tokio::spawn(run_with(worker_capacity, move || {
            let _ = started.send(());
            finish.recv().unwrap();
            Ok(())
        }));
        waiting.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(capacity.available_permits(), 0);
        assert_eq!(
            run_with(capacity.clone(), || Ok(()))
                .await
                .unwrap_err()
                .to_string(),
            "plugin.api.busy"
        );
        release.send(()).unwrap();
        let _settled = tokio::time::timeout(std::time::Duration::from_secs(2), capacity.acquire())
            .await
            .unwrap()
            .unwrap();
    }
}
