//! Shared prelaunch cancellation, authorization and total task deadline.
use crate::error::AppResult;
use std::{future::Future, time::Duration};
use tokio::{sync::watch, time::Instant};

pub(super) enum Outcome<T> {
    Ready(T),
    Stopped(&'static str),
}

pub(super) fn stopped(
    cancel: &watch::Receiver<bool>,
    expires: Instant,
    mut authorize: impl FnMut() -> AppResult<()>,
) -> Option<&'static str> {
    if *cancel.borrow() || cancel.has_changed().is_err() || authorize().is_err() {
        Some("cancelled")
    } else if Instant::now() >= expires {
        Some("timedOut")
    } else {
        None
    }
}

pub(super) async fn prepare<T>(
    future: impl Future<Output = AppResult<T>>,
    cancel: &mut watch::Receiver<bool>,
    expires: Instant,
    mut authorize: impl FnMut() -> AppResult<()>,
) -> AppResult<Outcome<T>> {
    if let Some(reason) = stopped(cancel, expires, &mut authorize) {
        return Ok(Outcome::Stopped(reason));
    }
    tokio::pin!(future);
    let mut interval = tokio::time::interval(Duration::from_millis(200));
    loop {
        tokio::select! {
            biased;
            _ = super::cancelled(cancel) => return Ok(Outcome::Stopped("cancelled")),
            _ = tokio::time::sleep_until(expires) => return Ok(Outcome::Stopped("timedOut")),
            _ = interval.tick() => if let Some(reason) = stopped(cancel, expires, &mut authorize) {
                return Ok(Outcome::Stopped(reason));
            },
            result = &mut future => {
                if let Some(reason) = stopped(cancel, expires, &mut authorize) {
                    return Ok(Outcome::Stopped(reason));
                }
                return Ok(Outcome::Ready(result?));
            },
        }
    }
}

#[cfg(test)]
mod tests;
