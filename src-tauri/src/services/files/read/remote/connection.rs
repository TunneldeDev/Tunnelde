use super::*;
use crate::{services::files::read::budget, state::AppState};
use russh_sftp::{
    client::rawsession::Limits,
    protocol::{FileAttributes, OpenFlags},
};
use tauri::Manager;
use tokio::io::{AsyncRead, AsyncWrite};

const OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

impl RemoteReader {
    pub async fn open(
        app: tauri::AppHandle,
        session_id: String,
        path: String,
    ) -> AppResult<(Self, u64)> {
        validate_path(&path)?;
        let permit = reserve_connection()?;
        budget::run_async(move |job| async move {
            let result = tokio::time::timeout(OPEN_TIMEOUT, async {
                let channel = app
                    .state::<AppState>()
                    .ssh
                    .handle(&session_id)?
                    .channel_open_session()
                    .await
                    .map_err(|error| AppError::Ssh(format!("sftp.channel: {error}")))?;
                job.check()?;
                channel
                    .request_subsystem(true, "sftp")
                    .await
                    .map_err(|error| AppError::Ssh(format!("sftp.subsystem: {error}")))?;
                job.check()?;
                Self::negotiate(channel.into_stream(), path, &job, permit).await
            })
            .await
            .map_err(|_| AppError::Ssh("sftp.transferTimedOut".into()))?;
            job.check()?;
            result
        })
        .await
    }

    #[cfg(test)]
    pub(crate) async fn from_stream(
        stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
        path: String,
    ) -> AppResult<(Self, u64)> {
        validate_path(&path)?;
        let permit = reserve_connection()?;
        budget::run_async(move |job| async move {
            let result =
                tokio::time::timeout(OPEN_TIMEOUT, Self::negotiate(stream, path, &job, permit))
                    .await
                    .map_err(|_| AppError::Ssh("sftp.transferTimedOut".into()))??;
            job.check()?;
            Ok(result)
        })
        .await
    }

    async fn negotiate(
        stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
        path: String,
        job: &budget::Cancellation,
        permit: OwnedSemaphorePermit,
    ) -> AppResult<(Self, u64)> {
        let mut raw = RawSftpSession::new_with_config(
            stream,
            russh_sftp::client::Config {
                request_timeout_secs: 15,
                max_packet_len: 256 * 1024,
                ..Default::default()
            },
        );
        let version = raw.init().await.map_err(map_sftp)?;
        job.check()?;
        let limits = if version
            .extensions
            .get("limits@openssh.com")
            .map(String::as_str)
            == Some("1")
        {
            Limits::from(raw.limits().await.map_err(map_sftp)?)
        } else {
            Limits::default()
        };
        job.check()?;
        let packet = limits.packet_len.unwrap_or(256 * 1024).min(256 * 1024);
        let read_size = limits
            .read_len
            .unwrap_or(32 * 1024)
            .min(256 * 1024 - 13)
            .min(packet.saturating_sub(13));
        if read_size == 0 {
            return Err(AppError::validation("fileRead.invalidReply"));
        }
        raw.set_limits(limits);
        let before = raw.stat(path.clone()).await.map_err(map_sftp)?.attrs;
        if !before.file_type().is_file() {
            return Err(invalid_path());
        }
        job.check()?;
        // SFTP v3 cannot promise O_NOFOLLOW or interrupt a blocked server-side
        // open. Check the resulting handle and bound the entire channel lifetime.
        let handle = raw
            .open(path, OpenFlags::READ, FileAttributes::empty())
            .await
            .map_err(map_sftp)?
            .handle;
        job.check()?;
        let metadata = raw.fstat(handle.clone()).await.map_err(map_sftp)?.attrs;
        if !metadata.file_type().is_file() {
            return Err(invalid_path());
        }
        let size = metadata
            .size
            .ok_or_else(|| AppError::validation("fileRead.metadataUnavailable"))?;
        job.check()?;
        Ok((
            Self(Arc::new(Opened {
                raw,
                handle,
                read_size: read_size as usize,
                _permit: permit,
            })),
            size,
        ))
    }
}

fn validate_path(path: &str) -> AppResult<()> {
    if !path.starts_with('/') || path.len() > 32768 || path.contains('\0') {
        return Err(invalid_path());
    }
    Ok(())
}
