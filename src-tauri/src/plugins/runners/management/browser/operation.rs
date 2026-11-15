//! One probe/trust/connect at a time; no connection or metadata lock crosses await.
use super::{
    destination,
    registry::{Connection, Pending},
};
use crate::{error::AppResult, ssh::session::review::Target};
use tauri::{AppHandle, Manager};

mod reservation;
use reservation::Reservation;

pub(super) struct Operation<'a> {
    app: &'a AppHandle,
    pending: &'a Pending,
    _reservation: Reservation<'a>,
}
impl<'a> Operation<'a> {
    pub async fn begin(app: &'a AppHandle, pending: &'a Pending) -> AppResult<(Self, Target)> {
        let (reservation, target) = Reservation::capture(
            pending,
            || destination::current(app, pending),
            |review| async move { Target::capture_background(app, &review).await },
        )
        .await?;
        Ok((
            Self {
                app,
                pending,
                _reservation: reservation,
            },
            target,
        ))
    }
    pub fn accept(
        app: &'a AppHandle,
        pending: &'a Pending,
    ) -> AppResult<(Self, Option<crate::ssh::session::review::Review>)> {
        let (reservation, review) =
            Reservation::accept(pending, || destination::current(app, pending))?;
        Ok((
            Self {
                app,
                pending,
                _reservation: reservation,
            },
            review,
        ))
    }

    pub fn with_current<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        self.app
            .state::<crate::state::AppState>()
            .runners
            .browsers
            .with_current(self.pending, || {
                let mut connection = self
                    .pending
                    .connection
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                destination::with_current(self.app, self.pending, || operation(&mut connection))
            })
    }
}
