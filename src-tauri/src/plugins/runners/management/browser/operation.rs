//! One probe/trust/connect at a time; no connection or metadata lock crosses await.
use super::{
    destination,
    registry::{Connection, Pending},
};
use crate::{
    error::{AppError, AppResult},
    ssh::session::review::Target,
};
use tauri::AppHandle;

pub(super) struct Operation<'a> {
    app: &'a AppHandle,
    pending: &'a Pending,
}
impl<'a> Operation<'a> {
    pub fn begin(app: &'a AppHandle, pending: &'a Pending) -> AppResult<(Self, Target)> {
        let mut connection = pending.connection.lock().unwrap_or_else(|e| e.into_inner());
        destination::current(app, pending)?;
        if connection.busy || connection.session.is_some() {
            return Err(AppError::validation("plugin.runners.busy"));
        }
        let review = connection
            .review
            .as_ref()
            .ok_or_else(|| AppError::validation("plugin.runners.browserExpired"))?;
        let target = Target::capture(app, review)?;
        connection.busy = true;
        Ok((Self { app, pending }, target))
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
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.pending
            .connection
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .busy = false;
    }
}
