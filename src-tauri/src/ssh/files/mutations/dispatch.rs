//! Each remote mutation is gated after awaited preparation, before polling I/O.
use super::super::native_save::runtime::MutationObservation;
use crate::error::{AppError, AppResult};
use russh_sftp::client::error::Error;
use std::{future::Future, sync::Arc};

#[derive(Clone)]
pub(in super::super) struct Dispatch {
    validate: Arc<dyn Fn() -> AppResult<()> + Send + Sync>,
    observation: MutationObservation,
}
impl Dispatch {
    pub(in super::super) fn new(
        validate: impl Fn() -> AppResult<()> + Send + Sync + 'static,
        observation: MutationObservation,
    ) -> Self {
        Self {
            validate: Arc::new(validate),
            observation,
        }
    }
    pub(in super::super) async fn request<T>(
        &self,
        request: impl Future<Output = Result<T, Error>>,
    ) -> AppResult<T> {
        self.request_with(request, super::super::map_sftp).await
    }
    pub(in super::super) async fn request_with<T>(
        &self,
        request: impl Future<Output = Result<T, Error>>,
        map: impl FnOnce(Error) -> AppError,
    ) -> AppResult<T> {
        (self.validate)()?;
        self.observation.request(request).await.map_err(map)
    }
    pub(in super::super) async fn opaque<T>(
        &self,
        request: impl Future<Output = AppResult<T>>,
    ) -> AppResult<T> {
        (self.validate)()?;
        self.observation.opaque(request).await
    }
    /// Closing an already admitted handle is completion, not another path write.
    /// Revocation must not drop the original CLOSE reply or leak its ownership.
    pub(super) async fn close(
        &self,
        request: impl Future<Output = AppResult<()>>,
    ) -> AppResult<()> {
        self.observation.opaque(request).await
    }
}

#[cfg(test)]
mod tests;
