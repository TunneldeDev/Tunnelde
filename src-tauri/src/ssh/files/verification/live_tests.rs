use super::*;
use crate::ssh::files::{artifacts, display_path, map_sftp, segments, source_stamp};
use russh::client;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
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

async fn write(endpoint: &Endpoint, sftp: &SftpSession, bytes: &[u8]) -> AppResult<()> {
    if endpoint.session.is_some() {
        let mut file = sftp.create(&endpoint.path).await.map_err(map_sftp)?;
        let result = file.write_all(bytes).await;
        let closed = file.close().await;
        result?;
        closed.map_err(Into::into)
    } else {
        tokio::fs::write(&endpoint.path, bytes)
            .await
            .map_err(Into::into)
    }
}

async fn corrupt_preserving_stamp(
    endpoint: &Endpoint,
    sftp: &SftpSession,
    mut bytes: Vec<u8>,
) -> AppResult<()> {
    bytes[CHUNK * 2] ^= 1;
    if endpoint.session.is_some() {
        let before = sftp.metadata(&endpoint.path).await.map_err(map_sftp)?;
        write(endpoint, sftp, &bytes).await?;
        sftp.set_metadata(
            &endpoint.path,
            russh_sftp::protocol::FileAttributes {
                mtime: before.mtime,
                atime: before.atime,
                ..russh_sftp::protocol::FileAttributes::empty()
            },
        )
        .await
        .map_err(map_sftp)?;
    } else {
        let modified = std::fs::metadata(&endpoint.path)?.modified()?;
        write(endpoint, sftp, &bytes).await?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&endpoint.path)?
            .set_times(std::fs::FileTimes::new().set_modified(modified))?;
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires disposable SSH host credentials and explicitly trusted fingerprint"]
async fn live_resume_checks_middle_changes_and_continuation_in_both_directions() {
    let host = std::env::var("TUNNELDE_TEST_HOST").expect("TUNNELDE_TEST_HOST");
    let user = std::env::var("TUNNELDE_TEST_USER").expect("TUNNELDE_TEST_USER");
    let password = std::env::var("TUNNELDE_TEST_PASSWORD").expect("TUNNELDE_TEST_PASSWORD");
    let fingerprint =
        std::env::var("TUNNELDE_TEST_FINGERPRINT").expect("TUNNELDE_TEST_FINGERPRINT");
    let mut handle = client::connect(
        Arc::new(client::Config::default()),
        (host, 22),
        TrustedServer(fingerprint),
    )
    .await
    .unwrap();
    assert!(handle
        .authenticate_password(user, password)
        .await
        .unwrap()
        .success());
    let channel = handle.channel_open_session().await.unwrap();
    channel.request_subsystem(true, "sftp").await.unwrap();
    let sftp = SftpSession::new_with_config(
        channel.into_stream(),
        segments::config(&crate::settings::Settings::default()),
    )
    .await
    .unwrap();
    let id = uuid::Uuid::new_v4();
    let remote = format!("/tmp/tunnelde-resume-test-{id}");
    let local = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../.tmp/qa")
        .join(format!("resume-{id}"));
    tokio::fs::create_dir_all(&local).await.unwrap();
    sftp.create_dir(&remote).await.unwrap();
    println!("Created disposable resume fixture: {remote}");
    let endpoint = |remote_side: bool, name: &str| Endpoint {
        session: remote_side.then(|| "live".into()),
        path: if remote_side {
            format!("{remote}/{name}")
        } else {
            display_path(&local.join(name))
        },
    };
    let data: Vec<u8> = (0..1024 * 1024 + 73).map(|n| (n % 251) as u8).collect();
    let existing = (data.len() - CHUNK - 9) as u64;
    let cancel = AtomicBool::new(false);
    let result = async {
        for (source_remote, target_remote) in [(false, true), (true, false), (true, true)] {
            let source = endpoint(source_remote, "source.bin");
            let partial = endpoint(target_remote, "partial.bin");
            let source_sftp = source_remote.then_some(&sftp);
            let target_sftp = target_remote.then_some(&sftp);
            write(&source, &sftp, &data).await?;
            write(&partial, &sftp, &data[..existing as usize]).await?;
            let mut reader = open_reader(&source, source_sftp).await?;
            let started = Instant::now();
            let verified = artifacts::resume_offset(&mut reader, &partial, target_sftp, existing, &cancel).await;
            println!("resume source_remote={source_remote} target_remote={target_remote} prefix_bytes={existing} elapsed_ms={}", started.elapsed().as_millis());
            verified?;
            let mut remainder = vec![0; data.len() - existing as usize];
            let read = super::read_block(&mut reader, &mut remainder).await;
            reader.finish().await?;
            read?;
            if remainder != data[existing as usize..] {
                return Err(AppError::internal("resume continuation read incorrect bytes"));
            }
            for changed_source in [false, true] {
                write(&source, &sftp, &data).await?;
                write(&partial, &sftp, &data[..existing as usize]).await?;
                let (changed, channel, bytes) = if changed_source {
                    (&source, source_sftp, data.clone())
                } else {
                    (&partial, target_sftp, data[..existing as usize].to_vec())
                };
                let before = source_stamp(changed, channel).await?;
                corrupt_preserving_stamp(changed, &sftp, bytes).await?;
                if source_stamp(changed, channel).await? != before {
                    return Err(AppError::internal("fixture did not preserve file metadata"));
                }
                let mut reader = open_reader(&source, source_sftp).await?;
                let checked = artifacts::resume_offset(&mut reader, &partial, target_sftp, existing, &cancel).await;
                reader.finish().await?;
                if checked.err().map(|error| error.to_string()).as_deref() != Some("sftp.resumePrefixMismatch") {
                    return Err(AppError::internal("resume accepted corrupted middle bytes"));
                }
                println!("rejected middle change source_remote={source_remote} target_remote={target_remote} changed_source={changed_source} metadata_preserved=true");
            }
        }
        Ok::<(), AppError>(())
    }.await;
    let mut cleanup_errors = Vec::new();
    for name in ["source.bin", "partial.bin"] {
        if let Err(error) = sftp.remove_file(format!("{remote}/{name}")).await {
            if !matches!(&error, russh_sftp::client::error::Error::Status(status)
                if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile)
            {
                cleanup_errors.push(error.to_string());
            }
        }
        if let Err(error) = tokio::fs::remove_file(local.join(name)).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                cleanup_errors.push(error.to_string());
            }
        }
    }
    if let Err(error) = sftp.remove_dir(&remote).await {
        cleanup_errors.push(error.to_string());
    }
    if let Err(error) = tokio::fs::remove_dir(&local).await {
        cleanup_errors.push(error.to_string());
    }
    sftp.close().await.unwrap();
    assert!(
        cleanup_errors.is_empty(),
        "Fixture cleanup failed: {cleanup_errors:?}"
    );
    println!("Removed disposable resume fixture: {remote}");
    result.unwrap();
}
