//! Transport disposal owns its worker even when the initiating RPC disappears.
use super::{close_transports, SessionHandle, WriterMsg};
use crate::error::{AppError, AppResult};
use std::{sync::Arc, time::Duration};

pub(crate) struct SessionDisposal(tauri::async_runtime::JoinHandle<AppResult<()>>);
impl SessionDisposal {
    pub(super) fn start(handle: SessionHandle, session_id: String) -> Self {
        let _ = handle.writer.try_send(WriterMsg::Close);
        handle.task.abort();
        Self(tauri::async_runtime::spawn(async move {
            close_transports(
                std::iter::once(&handle.handle)
                    .chain(handle._jumps.iter().rev())
                    .map(Arc::as_ref),
                Some(&session_id),
            )
            .await;
            let result = tokio::time::timeout(Duration::from_secs(5), async {
                while !handle.handle.is_closed()
                    || handle._jumps.iter().any(|jump| !jump.is_closed())
                {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                let _ = handle.task.await;
            })
            .await;
            if result.is_err() {
                tracing::warn!(%session_id, "SSH transport cleanup did not settle before its deadline");
                return Err(AppError::Ssh("plugin.resources.cleanupIncomplete".into()));
            }
            Ok(())
        }))
    }
    pub(crate) async fn finish(self) -> AppResult<()> {
        self.0
            .await
            .map_err(|_| AppError::internal("plugin.resources.workerFailed"))?
    }
}
