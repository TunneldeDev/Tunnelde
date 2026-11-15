//! Own the busy slot while capturing a route without holding its cancellation lock.
use super::super::registry::{self, Pending};
use crate::{
    error::{AppError, AppResult},
    ssh::session::review::Review,
};
use std::future::Future;

pub(super) struct Reservation<'a> {
    pending: &'a Pending,
}

impl<'a> Reservation<'a> {
    pub(super) fn accept(
        pending: &'a Pending,
        validate: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<(Self, Option<Review>)> {
        let mut connection = pending.connection.lock().unwrap_or_else(|e| e.into_inner());
        validate()?;
        if connection.busy {
            return Err(AppError::validation("plugin.runners.busy"));
        }
        if connection.session.is_none() {
            return Err(AppError::validation("ssh.sessionMissing"));
        }
        let review = if connection.acquired {
            Some(
                connection
                    .review
                    .clone()
                    .ok_or_else(|| AppError::validation("plugin.runners.browserExpired"))?,
            )
        } else {
            None
        };
        connection.busy = true;
        Ok((Self { pending }, review))
    }

    pub(super) async fn capture<T, F: Future<Output = AppResult<T>>>(
        pending: &'a Pending,
        mut validate: impl FnMut() -> AppResult<()>,
        capture: impl FnOnce(Review) -> F,
    ) -> AppResult<(Self, T)> {
        registry::guard(pending, async {
            let (reservation, review) = {
                let mut connection = pending.connection.lock().unwrap_or_else(|e| e.into_inner());
                validate()?;
                if connection.busy || connection.session.is_some() {
                    return Err(AppError::validation("plugin.runners.busy"));
                }
                let review = connection
                    .review
                    .clone()
                    .ok_or_else(|| AppError::validation("plugin.runners.browserExpired"))?;
                connection.busy = true;
                (Self { pending }, review)
            };
            // The worker receives the original review, never a later replacement.
            // Cancellation can acquire the mutex and drop this reservation even
            // if an OS credential prompt has not returned yet.
            let target = capture(review).await?;
            {
                let _connection = pending.connection.lock().unwrap_or_else(|e| e.into_inner());
                validate()?;
            }
            Ok((reservation, target))
        })
        .await
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        self.pending
            .connection
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .busy = false;
    }
}

#[cfg(test)]
mod tests;
