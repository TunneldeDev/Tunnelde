//! Compatibility adapter; native source ownership belongs to file services.
pub use crate::services::files::read::Source;

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
        let (reader, size) = crate::services::files::read::RemoteReader::from_stream(
            channel.into_stream(),
            path.clone(),
        )
        .await
        .unwrap();
        let source = Source::Remote(reader);
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
