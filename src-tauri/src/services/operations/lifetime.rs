//! An admitted effect outlives its caller, including nested budget workers.
//! This is private process-local ownership, never a cancellation capability.
use super::Authority;
use crate::error::AppResult;
use std::{future::Future, sync::Arc};

#[derive(Clone, Default)]
pub(crate) struct WorkLifetime {
    _guard: Option<Arc<dyn Send + Sync>>,
    authority: Option<Arc<dyn Authority>>,
}
tokio::task_local! {
    static CURRENT: WorkLifetime;
}
impl WorkLifetime {
    pub(crate) fn new(guard: impl Send + Sync + 'static) -> Self {
        Self {
            _guard: Some(Arc::new(guard)),
            authority: None,
        }
    }
    pub(crate) fn authorized(authority: Arc<dyn Authority>) -> Self {
        Self {
            _guard: None,
            authority: Some(authority),
        }
    }
    pub(crate) fn check() -> AppResult<()> {
        Self::with_current(|| Ok(()))
    }
    pub(crate) fn with_current<T>(effect: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        Self::current().with(effect)
    }
    /// Use the original request's authority, not whatever task happens to
    /// consume it later. Only short transactions, never OS IO, belong here.
    pub(crate) fn with<T>(&self, effect: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        let Some(authority) = &self.authority else {
            return effect();
        };
        let mut effect = Some(effect);
        let mut result = None;
        authority.with_current(&mut || {
            result = Some(effect.take().expect("authority commits at most once")()?);
            Ok(())
        })?;
        Ok(result.expect("authority must admit the effect before succeeding"))
    }
    pub(crate) fn is_empty(&self) -> bool {
        self._guard.is_none() && self.authority.is_none()
    }
    /// Cleanup cannot need fresh consent from an already retired origin. Keep
    /// its fence as an opaque guard, but do not authorize NEW work under it.
    pub(crate) fn retirement(self) -> Self {
        Self {
            _guard: Some(Arc::new(self)),
            authority: None,
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
