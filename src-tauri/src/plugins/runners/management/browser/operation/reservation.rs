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
