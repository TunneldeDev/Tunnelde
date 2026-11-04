use super::*;
use russh::client;
use std::time::Instant;

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

async fn data_channel(handle: &client::Handle<TrustedServer>) -> Arc<DataSession> {
    let channel = handle.channel_open_session().await.unwrap();
    channel.request_subsystem(true, "sftp").await.unwrap();
    Arc::new(DataSession::new(channel.into_stream()).await.unwrap())
}

async fn sequential(source: &Endpoint, target: &Endpoint, sftp: &SftpSession) -> AppResult<()> {
    let mut reader = open_reader(source, source.session.as_ref().map(|_| sftp)).await?;
    let mut writer = open_writer(target, target.session.as_ref().map(|_| sftp), false).await?;
    let result = async {
        let mut buffer = vec![0; CHUNK];
        loop {
            let size = reader.read(&mut buffer).await?;
            if size == 0 {
                break;
            }
            writer.write_all(&buffer[..size]).await?;
        }
        Ok::<(), AppError>(())
    }
    .await;
    let (written, read) = tokio::join!(writer.finish(), reader.finish());
    result.and(written).and(read)
}

async fn parallel(
    source: &Endpoint,
    target: &Endpoint,
    sftp: &SftpSession,
    sessions: &Sessions,
    length: u64,
) -> AppResult<()> {
    let settings = crate::settings::Settings::default();
    let plan = super::super::segments::Plan::for_file(&settings, length, true);
    open_writer(target, target.session.as_ref().map(|_| sftp), false)
        .await?
        .finish()
        .await?;
    let files = Files::open(sessions, source, target).await?;
    let result = async {
        let mut offset = 0;
        while offset < length {
            let end = (offset + plan.chunk * plan.workers as u64).min(length);
            super::super::segments::copy_window(
                &files,
                offset..end,
                plan,
                &AtomicBool::new(false),
                |_| {},
            )
            .await?;
            offset = end;
        }
        Ok::<(), AppError>(())
    }
    .await;
    let closed = files.close().await;
    result.and(closed)
}

/// Opt-in: requires a disposable test host and an explicitly trusted SHA256
/// fingerprint. Touches only a freshly created /tmp directory through SFTP.
#[tokio::test]
#[ignore = "requires TUNNELDE_TEST_HOST/USER/PASSWORD/FINGERPRINT and a disposable SSH host"]
async fn live_segmented_transfers_match_bytes_and_measure_baseline() {
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
    let sftp = SftpSession::new(channel.into_stream()).await.unwrap();
    let local_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.tmp/qa")
        .join(format!("transfer-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&local_root).unwrap();
    let size_mib = std::env::var("TUNNELDE_TEST_SIZE_MIB")
        .ok()
        .and_then(|size| size.parse::<usize>().ok())
        .unwrap_or(32)
        .clamp(1, 256);
    let content: Vec<_> = (0_usize..size_mib * 1024 * 1024 + 73)
        .map(|n| ((n * 73 + n / 257) % 251) as u8)
        .collect();
    std::fs::write(local_root.join("source.bin"), &content).unwrap();
    let remote_root = format!("/tmp/tunnelde-transfer-test-{}", uuid::Uuid::new_v4());
    std::fs::write(local_root.join("remote-root.txt"), &remote_root).unwrap();
    sftp.create_dir(&remote_root).await.unwrap();
    println!("Created disposable test directory: {remote_root}");
    let endpoint = |name: &str, remote: bool| Endpoint {
        session: remote.then(|| "live".into()),
        path: if remote {
            format!("{remote_root}/{name}")
        } else {
            display_path(&local_root.join(name))
        },
    };
    let result = async {
        let upload_sessions = Sessions {
            source: None,
            target: Some(data_channel(&handle).await),
        };
        let download_sessions = Sessions {
            source: Some(data_channel(&handle).await),
            target: None,
        };
        let copy_sessions = Sessions {
            source: upload_sessions.target.clone(),
            target: download_sessions.source.clone(),
        };
        for (label, source, target, sessions, optimized) in [
            (
                "baseline-upload",
                endpoint("source.bin", false),
                endpoint("baseline.bin", true),
                &upload_sessions,
                false,
            ),
            (
                "segmented-upload",
                endpoint("source.bin", false),
                endpoint("parallel.bin", true),
                &upload_sessions,
                true,
            ),
            (
                "baseline-download",
                endpoint("baseline.bin", true),
                endpoint("baseline-download.bin", false),
                &download_sessions,
                false,
            ),
            (
                "segmented-download",
                endpoint("parallel.bin", true),
                endpoint("parallel-download.bin", false),
                &download_sessions,
                true,
            ),
            (
                "segmented-remote-copy",
                endpoint("parallel.bin", true),
                endpoint("remote-copy.bin", true),
                &copy_sessions,
                true,
            ),
        ] {
            let started = Instant::now();
            if optimized {
                parallel(&source, &target, &sftp, sessions, content.len() as u64).await?;
            } else {
                sequential(&source, &target, &sftp).await?;
            }
            println!(
                "{label}: {:.2} MiB/s ({:.3}s)",
                content.len() as f64 / 1048576.0 / started.elapsed().as_secs_f64(),
                started.elapsed().as_secs_f64()
            );
            let actual = match target.session {
                Some(_) => sftp.read(&target.path).await.map_err(map_sftp)?,
                None => tokio::fs::read(&target.path).await?,
            };
            assert_eq!(actual, content, "{label} data mismatch");
        }
        Ok::<(), AppError>(())
    }
    .await;
    for name in ["baseline.bin", "parallel.bin", "remote-copy.bin"] {
        match sftp.remove_file(format!("{remote_root}/{name}")).await {
            Ok(()) => {}
            Err(russh_sftp::client::error::Error::Status(status))
                if status.status_code == StatusCode::NoSuchFile => {}
            Err(error) => panic!("test-owned file cleanup failed: {error}"),
        }
    }
    sftp.remove_dir(&remote_root).await.unwrap();
    sftp.close().await.unwrap();
    std::fs::remove_dir_all(local_root).unwrap();
    result.unwrap();
}

/// Compare negotiated packets against the legacy 32 KiB cap. Set
/// TUNNELDE_TEST_COMPARE_NODELAY=1 to isolate TCP_NODELAY instead. Keeping this
/// opt-in avoids deriving a performance guarantee from a shared CI network.
#[tokio::test]
#[ignore = "requires disposable SSH host credentials and explicitly trusted fingerprint"]
async fn live_upload_compares_packet_budget_or_tcp_nodelay_with_identical_data() {
    let host = std::env::var("TUNNELDE_TEST_HOST").expect("TUNNELDE_TEST_HOST");
    let user = std::env::var("TUNNELDE_TEST_USER").expect("TUNNELDE_TEST_USER");
    let password = std::env::var("TUNNELDE_TEST_PASSWORD").expect("TUNNELDE_TEST_PASSWORD");
    let fingerprint =
        std::env::var("TUNNELDE_TEST_FINGERPRINT").expect("TUNNELDE_TEST_FINGERPRINT");
    let local_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.tmp/qa")
        .join(format!("nodelay-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&local_root).unwrap();
    let mut seed = 0x12345678_u32;
    let content: Vec<_> = (0..8 * 1024 * 1024 + 17)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as u8
        })
        .collect();
    let source = Endpoint {
        session: None,
        path: display_path(&local_root.join("source.bin")),
    };
    std::fs::write(&source.path, &content).unwrap();
    let compare_nodelay = std::env::var("TUNNELDE_TEST_COMPARE_NODELAY").as_deref() == Ok("1");
    for (round, enabled) in [false, true, false, true].into_iter().enumerate() {
        let socket = tokio::net::TcpStream::connect((host.as_str(), 22))
            .await
            .unwrap();
        socket.set_nodelay(compare_nodelay && enabled).unwrap();
        let mut handle = client::connect_stream(
            Arc::new(client::Config::default()),
            socket,
            TrustedServer(fingerprint.clone()),
        )
        .await
        .unwrap();
        assert!(handle
            .authenticate_password(&user, &password)
            .await
            .unwrap()
            .success());
        let channel = handle.channel_open_session().await.unwrap();
        channel.request_subsystem(true, "sftp").await.unwrap();
        let sftp = SftpSession::new(channel.into_stream()).await.unwrap();
        let folder = format!("/tmp/tunnelde-nodelay-test-{}", uuid::Uuid::new_v4());
        std::fs::write(local_root.join(format!("remote-{round}.txt")), &folder).unwrap();
        sftp.create_dir(&folder).await.unwrap();
        let target = Endpoint {
            session: Some("benchmark".into()),
            path: format!("{folder}/payload.bin"),
        };
        let mut sessions = Sessions {
            source: None,
            target: Some(data_channel(&handle).await),
        };
        if !compare_nodelay && !enabled {
            Arc::get_mut(sessions.target.as_mut().unwrap())
                .unwrap()
                .write_size = 32768;
        }
        let started = Instant::now();
        let copied = parallel(&source, &target, &sftp, &sessions, content.len() as u64).await;
        let seconds = started.elapsed().as_secs_f64();
        println!(
            "round={round} compare_nodelay={compare_nodelay} enabled={enabled} packet={}: {:.2} MiB/s ({seconds:.3}s)",
            sessions.target.as_ref().unwrap().write_size,
            content.len() as f64 / 1048576.0 / seconds
        );
        let verified = match &copied {
            Ok(()) => sftp
                .read(&target.path)
                .await
                .map(|actual| actual == content),
            Err(_) => Ok(false),
        };
        let removed = sftp.remove_file(&target.path).await;
        let directory_removed = sftp.remove_dir(&folder).await;
        let _ = sftp.close().await;
        copied.unwrap();
        assert!(verified.unwrap(), "transferred bytes differ");
        removed.unwrap();
        directory_removed.unwrap();
    }
    std::fs::remove_dir_all(local_root).unwrap();
}
