use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::error::{AppError, AppResult};

pub struct RemoteSession(Option<russh_sftp::client::SftpSession>);

impl std::ops::Deref for RemoteSession {
    type Target = russh_sftp::client::SftpSession;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref().expect("live remote preview session")
    }
}

impl Drop for RemoteSession {
    fn drop(&mut self) {
        if let Some(session) = self.0.take() {
            tauri::async_runtime::spawn(async move {
                let _ =
                    tokio::time::timeout(std::time::Duration::from_secs(3), session.close()).await;
            });
        }
    }
}

pub enum Source {
    Local(crate::services::files::read::LocalReader),
    Remote {
        file: Box<russh_sftp::client::fs::File>,
        session: RemoteSession,
    },
}

impl Source {
    pub async fn open(
        app: &tauri::AppHandle,
        session_id: Option<&str>,
        path: &str,
    ) -> AppResult<(Self, u64)> {
        if path.len() > 32768 || path.contains('\0') {
            return Err(AppError::validation("preview.invalidPath"));
        }
        if let Some(session_id) = session_id {
            if !path.starts_with('/') {
                return Err(AppError::validation("preview.invalidPath"));
            }
            Self::remote(crate::ssh::files::session(app, session_id).await?, path).await
        } else {
            let (reader, size) =
                crate::services::files::read::LocalReader::open(path.into()).await?;
            Ok((Self::Local(reader), size))
        }
    }

    async fn remote(
        session: russh_sftp::client::SftpSession,
        path: &str,
    ) -> AppResult<(Self, u64)> {
        let session = RemoteSession(Some(session));
        let result = async {
            let metadata = session
                .metadata(path)
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))?;
            if !metadata.file_type().is_file() {
                return Err(AppError::validation("preview.invalidPath"));
            }
            let file = session
                .open(path)
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))?;
            let metadata = file
                .metadata()
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))?;
            if !metadata.file_type().is_file() {
                return Err(AppError::validation("preview.invalidPath"));
            }
            Ok((file, metadata.len()))
        }
        .await;
        match result {
            Ok((file, size)) => Ok((
                Self::Remote {
                    file: Box::new(file),
                    session,
                },
                size,
            )),
            Err(error) => Err(error),
        }
    }

    pub async fn read(&mut self, start: u64, len: u64) -> AppResult<Vec<u8>> {
        if len > crate::services::files::read::MAX_READ_BYTES || start.checked_add(len).is_none() {
            return Err(AppError::validation("fileRead.invalidRange"));
        }
        match self {
            Self::Local(reader) => reader.read(start, len).await,
            Self::Remote { file, .. } => {
                let mut bytes = vec![0; len as usize];
                file.seek(std::io::SeekFrom::Start(start)).await?;
                file.read_exact(&mut bytes).await?;
                Ok(bytes)
            }
        }
    }

    pub async fn close(self) {
        if let Self::Remote { file, session } = self {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(3), (*file).close()).await;
            drop(session);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::client;
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    struct TrustedServer(String);
    impl client::Handler for TrustedServer {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            key: &russh::keys::PublicKeyOrCertificate,
        ) -> Result<bool, Self::Error> {
            Ok(key
                .public_key()
                .fingerprint(russh::keys::HashAlg::Sha256)
                .to_string()
                == self.0)
        }
    }

    #[tokio::test]
    #[ignore = "requires explicitly trusted disposable SSH host environment"]
    async fn live_remote_preview_reads_ranges_and_releases_only_its_own_files() {
        let host = std::env::var("TUNNELDE_TEST_HOST").unwrap();
        let user = std::env::var("TUNNELDE_TEST_USER").unwrap();
        let password = std::env::var("TUNNELDE_TEST_PASSWORD").unwrap();
        let fingerprint = std::env::var("TUNNELDE_TEST_FINGERPRINT").unwrap();
        let mut ssh = client::connect(
            Arc::new(client::Config::default()),
            (host, 22),
            TrustedServer(fingerprint),
        )
        .await
        .unwrap();
        assert!(ssh
            .authenticate_password(user, password)
            .await
            .unwrap()
            .success());
        let channel = ssh.channel_open_session().await.unwrap();
        channel.request_subsystem(true, "sftp").await.unwrap();
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .unwrap();
        let root = format!("/tmp/tunnelde-preview-test-{}", uuid::Uuid::new_v4());
        sftp.create_dir(&root).await.unwrap();
        let path = format!("{root}/range.bin");
        let bytes: Vec<_> = (0..2 * 1024 * 1024 + 73).map(|i| (i % 251) as u8).collect();
        let mut file = sftp.create(&path).await.unwrap();
        file.write_all(&bytes).await.unwrap();
        file.close().await.unwrap();
        let channel = ssh.channel_open_session().await.unwrap();
        channel.request_subsystem(true, "sftp").await.unwrap();
        let preview_session = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .unwrap();
        let (mut source, size) = Source::remote(preview_session, &path).await.unwrap();
        assert_eq!(size, bytes.len() as u64);
        for (start, length) in [(1_000_000, 1024 * 1024), (10, 30), (size - 73, 73)] {
            let actual = source.read(start, length).await.unwrap();
            assert_eq!(actual, bytes[start as usize..(start + length) as usize]);
        }
        source.close().await;
        assert_eq!(sftp.metadata(&path).await.unwrap().len(), size);
        sftp.remove_file(&path).await.unwrap();
        sftp.remove_dir(&root).await.unwrap();
        sftp.close().await.unwrap();
        ssh.disconnect(russh::Disconnect::ByApplication, "preview QA complete", "")
            .await
            .unwrap();
        println!("Remote range read and cleanup passed; disposable path: {root}");
    }
}
