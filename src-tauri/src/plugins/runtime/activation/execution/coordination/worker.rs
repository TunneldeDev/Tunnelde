use futures_util::FutureExt;
use std::{future::Future, panic::AssertUnwindSafe, sync::Arc, time::Duration};

use super::{entry::Entry, Coordinator, Key};
use crate::{
    error::{AppError, AppResult},
    plugins::{PluginInfo, PluginStatus},
};

// Covers package checks, initialize and frontend activation. Individual stages
// also retain their shorter deadlines. This is never extended by new waiters.
const START_DEADLINE: Duration = Duration::from_secs(45);

pub(super) fn spawn<W, F, S, C>(
    coordinator: Arc<Coordinator>,
    key: Key,
    entry: Arc<Entry>,
    work: W,
    settle: S,
) where
    W: FnOnce() -> F + Send + 'static,
    F: Future<Output = AppResult<PluginInfo>> + Send + 'static,
    S: FnOnce(bool) -> C + Send + 'static,
    C: Future<Output = AppResult<()>> + Send + 'static,
{
    tokio::spawn(async move {
        let mut cancelled = entry.cancelled.subscribe();
        let outcome = AssertUnwindSafe(async {
            if *cancelled.borrow_and_update() {
                return Err(AppError::validation("pluginSecurity.changed"));
            }
            tokio::select! {
                biased;
                _ = cancelled.changed() => Err(AppError::validation("pluginSecurity.changed")),
                _ = tokio::time::sleep(START_DEADLINE) => Err(AppError::validation("plugin.timeout")),
                result = async { work().await } => result,
            }
        }).catch_unwind().await.unwrap_or_else(|_| Err(AppError::internal("plugin.activation.failed")));
        let success = outcome
            .as_ref()
            .is_ok_and(|info| info.status == PluginStatus::Running);
        let settled = AssertUnwindSafe(async { settle(success).await })
            .catch_unwind()
            .await;
        let cleanup_error = match settled {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(_) => Some(AppError::internal("plugin.activation.cleanupFailed")),
        };
        let settled = cleanup_error.is_none();
        let outcome = if let Some(error) = cleanup_error {
            tracing::error!(plugin_id = %key.id, error_code = error.code(), "plugin startup settlement failed");
            // Unknown cleanup must not create unlimited detached work or allow
            // this operation to be reused. Retain its bounded, quarantined slot.
            entry.cancel();
            outcome.and(Err(error))
        } else {
            outcome
        };
        entry.finish(outcome);
        let mut entries = coordinator
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if settled
            && entries
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &entry))
        {
            entries.remove(&key);
        }
    });
}
