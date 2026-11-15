//! One probe/trust/connect at a time; no connection or metadata lock crosses await.
use super::{
    destination,
    registry::{Connection, Pending},
};
use crate::{error::AppResult, ssh::session::review::Target};
use tauri::AppHandle;

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
    pub fn with_current<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut connection = self
            .pending
            .connection
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        destination::with_current(self.app, self.pending, || operation(&mut connection))
    }
}
