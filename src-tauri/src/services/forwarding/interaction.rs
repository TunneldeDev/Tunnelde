//! Shared native-confirmation slot. Keep the permit in the actual dialog
//! callback so an expired request cannot accumulate abandoned modal dialogs.
use crate::error::{AppError, AppResult};
use std::sync::{Arc, LazyLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
pub(crate) fn admit() -> AppResult<OwnedSemaphorePermit> {
    static DIALOGS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(1)));
    DIALOGS
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::validation("forward.startBusy"))
}
