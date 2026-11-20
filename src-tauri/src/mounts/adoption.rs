//! Conversion owns the registry/group until persistence, ownership transfer and
//! host runtime publication have all settled, even after response cancellation.
use super::*;
use crate::services::operations::{Budget, Cancellation, Errors};
use std::sync::LazyLock;

impl MountRegistry {
    /// Configuration admission and transfer occur under one registry lock.
    /// The original SSH session is borrowed, never adopted or disconnected.
    pub(crate) async fn adopt_managed<T: Send + 'static>(
        &self,
        id: String,
        owner: impl Send + 'static,
        persist: impl FnOnce(&MountInfo, &Cancellation) -> AppResult<T> + Send + 'static,
        published: impl FnOnce(&T, &MountInfo) + Send + 'static,
    ) -> AppResult<T> {
        let mounts = self.mounts.clone().lock_owned().await;
        if self.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(AppError::validation("mounts.operations.cancelled"));
        }
        static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
            Budget::new(
                4,
                Errors {
                    domain: "mounts.legacy.convert",
                    busy: "mounts.operations.busy",
                    cancelled: "mounts.operations.cancelled",
                    failed: "mounts.operations.failed",
                },
            )
        });
        WORKERS
            .blocking(move |cancel| {
                let _owner = owner;
                let mut mounts = mounts;
                cancel.check()?;
                let active = mounts
                    .get_mut(&id)
                    .ok_or_else(|| AppError::NotFound("mounts.notFound".into()))?;
                if active.info.owner == crate::services::mounts::runtime::OWNER
                    || active.info.cleanup_error.is_some()
                    || active.bridge.is_finished()
                    || active.child.try_wait()?.is_some()
                {
                    return Err(AppError::validation("mounts.transportClosed"));
                }
                // persist must commit cancellation/authority at metadata admission.
                // Once it succeeds, no await or fallible operation can separate the
                // ownership update from host publication. Never reauthorize cleanup.
                let result = persist(&active.info, cancel)?;
                active.info.owner = crate::services::mounts::runtime::OWNER.into();
                active.generation = 0;
                published(&result, &active.info);
                Ok(result)
            })
            .await
    }
}

#[cfg(test)]
pub(crate) mod tests;
