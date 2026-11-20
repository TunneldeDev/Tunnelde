//! Bounded OS helpers retain process ownership until wait/reap.
//! Dismount collection runs inline in the owned mount transaction, not detached.
//! kill_on_drop is only a last-resort safeguard, not evidence of settlement.
#[cfg(any(target_os = "macos", all(test, unix)))]
use super::Command;
use crate::error::{AppError, AppResult};
use std::{process::Output, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Child,
};

#[cfg(any(target_os = "macos", all(test, unix)))]
pub(super) async fn output(
    mut command: Command,
    timeout: Duration,
    limit: usize,
    timeout_key: &'static str,
) -> AppResult<Output> {
    use crate::services::operations::{Budget, Errors};
    use std::sync::LazyLock;
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
        Budget::new(
            8,
            Errors {
                domain: "mounts.helper",
                busy: "mounts.helperBusy",
                cancelled: "plugin.api.cancelled",
                failed: "mounts.helperFailed",
            },
        )
    });
    WORKERS
        .asynchronous(move |cancel| async move {
            cancel.check()?;
            let mut child = command
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()?;
            collect(&mut child, timeout, limit, timeout_key).await
        })
        .await
}

pub(super) async fn collect(
    child: &mut Child,
    timeout: Duration,
    limit: usize,
    timeout_key: &'static str,
) -> AppResult<Output> {
    let result = tokio::time::timeout(timeout, async {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::internal("mounts.helperFailed"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::internal("mounts.helperFailed"))?;
        let status = async { child.wait().await.map_err(AppError::from) };
        let (stdout, stderr, status) = tokio::try_join!(
            read_bounded(stdout, limit),
            read_bounded(stderr, limit),
            status
        )?;
        Ok(Output {
            stdout,
            stderr,
            status,
        })
    })
    .await
    .map_err(|_| AppError::validation(timeout_key))
    .and_then(|result| result);
    if child.id().is_some() {
        // A delivery timeout/cancel cannot detach this cleanup. The Budget
        // worker owns both the child and the inherited WorkLifetime fence.
        let _ = child.kill().await;
        child.wait().await?;
    }
    result
}

async fn read_bounded(reader: impl AsyncRead + Unpin, limit: usize) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        return Err(AppError::validation("mounts.helperOutputTooLarge"));
    }
    Ok(bytes)
}

#[cfg(all(test, unix))]
mod tests;
