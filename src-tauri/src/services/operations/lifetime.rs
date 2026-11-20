//! An admitted effect outlives its caller, including nested budget workers.
//! This is private process-local ownership, never a cancellation capability.
use crate::error::AppResult;
use std::{future::Future, sync::Arc};

#[derive(Clone, Default)]
pub(crate) struct WorkLifetime {
    _guard: Option<Arc<dyn Send + Sync>>,
}
tokio::task_local! {
    static CURRENT: WorkLifetime;
}
impl WorkLifetime {
    pub(crate) fn new(guard: impl Send + Sync + 'static) -> Self {
        Self {
            _guard: Some(Arc::new(guard)),
        }
    }
    pub(crate) fn current() -> Self {
        CURRENT.try_with(Clone::clone).unwrap_or_default()
    }
    pub(crate) fn scope<F: Future>(self, work: F) -> impl Future<Output = F::Output> {
        CURRENT.scope(self, work)
    }
    pub(super) fn sync<T>(self, work: impl FnOnce() -> T) -> T {
        CURRENT.sync_scope(self, work)
    }
    pub(super) fn finish<T>(self, result: AppResult<T>) -> WorkerResult<T> {
        WorkerResult {
            result,
            _lifetime: self,
        }
    }
}
// Drop a lost worker's result (and any Delivery cleanup) BEFORE releasing its
// fence. Retaining only a worker-local guard would miss unreceived outputs.
pub(super) struct WorkerResult<T> {
    pub(super) result: AppResult<T>,
    _lifetime: WorkLifetime,
}
