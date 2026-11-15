//! Pending OPEN owns bounded capacity until confirmation or transport disposal.
use crate::{
    error::{AppError, AppResult},
    ssh::channel::OwnedChannel,
};
use russh::client;
use std::sync::{Arc, OnceLock};
use tokio::sync::{watch, Semaphore};
use tokio::time::Instant;

pub(super) async fn open<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    deadline: Instant,
    cancellation: &mut watch::Receiver<bool>,
) -> AppResult<Option<OwnedChannel>> {
    static OPENS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    open_with_capacity(
        handle,
        deadline,
        cancellation,
        OPENS
            .get_or_init(|| Arc::new(Semaphore::new(super::super::MAX_TASKS)))
            .clone(),
    )
    .await
}

async fn open_with_capacity<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    deadline: Instant,
    cancellation: &mut watch::Receiver<bool>,
    permits: Arc<Semaphore>,
) -> AppResult<Option<OwnedChannel>> {
    if *cancellation.borrow() || cancellation.has_changed().is_err() {
        return Ok(None);
    }
    if deadline <= Instant::now() {
        return Err(AppError::validation("plugin.tasks.channelTimeout"));
    }
    let permit = permits
        .try_acquire_owned()
        .map_err(|_| AppError::validation("plugin.tasks.busy"))?;
    let opened = super::super::until_cancelled(
        tokio::time::timeout_at(
            deadline,
            crate::ssh::channel::open(
                async move {
                    handle
                        .channel_open_session()
                        .await
                        .map_err(|error| AppError::Ssh(error.to_string()))
                },
                permit,
            ),
        ),
        cancellation,
    )
    .await;
    match opened {
        None => Ok(None),
        Some(result) => result
            .map_err(|_| AppError::validation("plugin.tasks.channelTimeout"))?
            .map(Some),
    }
}

#[cfg(test)]
mod tests;
