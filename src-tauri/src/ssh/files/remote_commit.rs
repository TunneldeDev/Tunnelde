use super::*;
use russh_sftp::client::RawSftpSession;
use russh_sftp::protocol::Packet;
use std::time::Duration;

/// Negotiate before uploading so an unsupported server cannot turn a complete
/// upload into an unexpected overwrite failure. The connection owns no writer.
pub(super) struct Replacement(RawSftpSession);

impl Replacement {
    pub(super) fn raw(&self) -> &RawSftpSession {
        &self.0
    }
    pub async fn connect(app: &AppHandle, session_id: &str) -> AppResult<Self> {
        tokio::time::timeout(Duration::from_secs(10), async {
            let handle = app.state::<AppState>().ssh.handle(session_id)?;
            let channel = handle
                .channel_open_session()
                .await
                .map_err(|error| AppError::Ssh(format!("sftp.channel: {error}")))?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|error| AppError::Ssh(format!("sftp.subsystem: {error}")))?;
            Self::negotiate(RawSftpSession::new(channel.into_stream())).await
        })
        .await
        .map_err(|_| AppError::Ssh("sftp.transferTimedOut".into()))?
    }

    pub(super) async fn negotiate(raw: RawSftpSession) -> AppResult<Self> {
        let version = raw.init().await.map_err(map_sftp)?;
        if version
            .extensions
            .get("posix-rename@openssh.com")
            .map(String::as_str)
            != Some("1")
        {
            return Err(AppError::validation("sftp.overwriteUnsupported"));
        }
        Ok(Self(raw))
    }

    /// Explicit replacement is one atomic server operation; no delete or backup
    /// rename fallback may expose a missing destination or destroy an old file.
    /// Consuming this channel also prevents reuse after a lost acknowledgement.
    pub async fn commit(self, from: &str, to: &str) -> AppResult<()> {
        self.replace(from, to).await
    }

    // Editor staging owns the channel until its cleanup has been attempted.
    // A failed commit is never retried on this channel.
    pub(super) async fn replace(&self, from: &str, to: &str) -> AppResult<()> {
        let mut payload = Vec::new();
        for path in [from, to] {
            let length = u32::try_from(path.len())
                .map_err(|_| AppError::validation("plugin.tools.invalidPath"))?;
            payload.extend_from_slice(&length.to_be_bytes());
            payload.extend_from_slice(path.as_bytes());
        }
        let reply = tokio::time::timeout(
            Duration::from_secs(10),
            self.0.extended("posix-rename@openssh.com", payload),
        )
        .await
        .map_err(|_| AppError::Ssh("sftp.transferTimedOut".into()))?
        .map_err(map_sftp)?;
        match reply {
            Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
            Packet::Status(status) => {
                Err(map_sftp(russh_sftp::client::error::Error::Status(status)))
            }
            _ => Err(map_sftp(russh_sftp::client::error::Error::UnexpectedPacket)),
        }
    }
}
