use super::*;
use std::time::Duration;
use tokio::io::{duplex, DuplexStream};

#[cfg(unix)]
#[test]
fn actual_python_worker_preserves_files_and_rejects_invalid_operations() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let output = std::process::Command::new("python3")
        .arg(manifest.join("src/ssh/files/compressed/worker_tests.py"))
        .arg(manifest.join("src/ssh/files/compressed.py"))
        .arg(manifest.join("../.tmp/qa"))
        .output()
        .expect("Python 3 is required to verify the optional transfer worker");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

async fn header(input: &mut BufReader<tokio::io::ReadHalf<DuplexStream>>) -> Value {
    let mut line = String::new();
    input.read_line(&mut line).await.unwrap();
    serde_json::from_str(&line).unwrap()
}

#[tokio::test]
async fn transport_sampling_keeps_incompressible_and_tiny_files_on_sftp() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.tmp/qa")
        .join(format!("compression-sample-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let endpoint = Endpoint {
        session: None,
        path: display_path(&root.join("source")),
    };
    tokio::fs::write(&endpoint.path, vec![b'a'; 32768])
        .await
        .unwrap();
    assert!(worthwhile(&endpoint, None).await.unwrap());
    tokio::fs::write(&endpoint.path, b"tiny").await.unwrap();
    assert!(!worthwhile(&endpoint, None).await.unwrap());
    let bytes: Vec<u8> = (0..32768).map(|_| rand::random()).collect();
    tokio::fs::write(&endpoint.path, &bytes).await.unwrap();
    assert!(!worthwhile(&endpoint, None).await.unwrap());
    assert_eq!(tokio::fs::read(&endpoint.path).await.unwrap(), bytes);
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[test]
fn adaptive_codec_handles_plain_compressed_and_unhelpful_data() {
    for bytes in [
        vec![b'a'; 262144],
        (0..262144).map(|_| rand::random::<u8>()).collect(),
        vec![7; 123],
    ] {
        let (packed, compressed) = encode(bytes.clone()).unwrap();
        assert_eq!(
            decode(packed.clone(), bytes.len(), compressed).unwrap(),
            bytes
        );
        if bytes.len() == 123 {
            assert!(!compressed);
        }
        if compressed {
            assert!(packed.len() * 10 < bytes.len() * 9);
        }
    }
}

#[test]
fn codec_rejects_truncated_trailing_and_excessive_output() {
    let (packed, compressed) = encode(vec![b'a'; 262144]).unwrap();
    assert!(compressed);
    assert!(decode(packed[..packed.len() - 1].to_vec(), 262144, true).is_err());
    let mut trailing = packed.clone();
    trailing.push(0);
    assert!(decode(trailing, 262144, true).is_err());
    assert!(decode(packed.clone(), 10, true).is_err());
    assert!(decode(packed, LIMIT + 1, true).is_err());
    assert!(decode(vec![1], 2, false).is_err());
}

#[tokio::test]
async fn protocol_pipelines_requests_and_routes_out_of_order_replies() {
    let (client, server) = duplex(1024 * 1024);
    let fixture = tokio::spawn(async move {
        let (input, mut output) = tokio::io::split(server);
        let mut input = BufReader::new(input);
        output.write_all(MAGIC).await.unwrap();
        let mut requests = Vec::new();
        for _ in 0..8 {
            let request = header(&mut input).await;
            let mut body = vec![0; request["size"].as_u64().unwrap() as usize];
            input.read_exact(&mut body).await.unwrap();
            assert_eq!(request["op"], "write");
            assert_eq!(
                decode(body, 65536, request["compressed"].as_bool().unwrap()).unwrap(),
                vec![b'x'; 65536]
            );
            requests.push(request);
        }
        for request in requests.iter().rev() {
            output
                .write_all(format!("{{\"id\":{},\"size\":0}}\n", request["id"]).as_bytes())
                .await
                .unwrap();
        }
        // Keep the peer alive until the session is dropped.
        let mut byte = [0];
        assert_eq!(input.read(&mut byte).await.unwrap(), 0);
    });
    let session = Session::new(client).await.unwrap();
    let writes = (0..8).map(|n| session.write("1", n * 65536, vec![b'x'; 65536]));
    tokio::time::timeout(
        Duration::from_secs(3),
        futures_util::future::try_join_all(writes),
    )
    .await
    .unwrap()
    .unwrap();
    drop(session);
    fixture.await.unwrap();
}

#[tokio::test]
async fn protocol_rejects_bad_handshake_and_oversized_frames_without_hanging() {
    let (client, mut server) = duplex(1024);
    server.write_all(&vec![0; MAGIC.len()]).await.unwrap();
    assert!(Session::new(client).await.is_err());
    let (client, mut server) = duplex(1024);
    server.write_all(MAGIC).await.unwrap();
    let session = Session::new(client).await.unwrap();
    let fixture = tokio::spawn(async move {
        let mut line = String::new();
        let mut server = BufReader::new(server);
        server.read_line(&mut line).await.unwrap();
        server
            .get_mut()
            .write_all(b"{\"id\":1,\"size\":1048577}\n")
            .await
            .unwrap();
    });
    assert!(
        tokio::time::timeout(Duration::from_secs(2), session.open("/test", false))
            .await
            .unwrap()
            .is_err()
    );
    fixture.await.unwrap();
}

#[tokio::test]
async fn cancelled_requests_hold_capacity_until_ack_and_session_drop_closes_peer() {
    let (client, mut server) = duplex(1024 * 1024);
    server.write_all(MAGIC).await.unwrap();
    let session = Arc::new(Session::new(client).await.unwrap());
    let mut input = BufReader::new(server);
    let request_session = session.clone();
    let task = tokio::spawn(async move { request_session.open("/cancelled", false).await });
    let request = {
        let mut line = String::new();
        input.read_line(&mut line).await.unwrap();
        serde_json::from_str::<Value>(&line).unwrap()
    };
    task.abort();
    let _ = task.await;
    assert_eq!(session.slots.available_permits(), 63);
    input
        .get_mut()
        .write_all(format!("{{\"id\":{},\"size\":0,\"handle\":\"1\"}}\n", request["id"]).as_bytes())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while session.slots.available_permits() != 64 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(session);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), input.read(&mut [0]))
            .await
            .unwrap()
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn worker_errors_do_not_desynchronize_following_requests() {
    let (client, server) = duplex(4096);
    let fixture = tokio::spawn(async move {
        let (input, mut output) = tokio::io::split(server);
        let mut input = BufReader::new(input);
        output.write_all(MAGIC).await.unwrap();
        let first = header(&mut input).await;
        output
            .write_all(
                format!(
                    "{{\"id\":{},\"size\":0,\"error\":\"missing\"}}\n",
                    first["id"]
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let next = header(&mut input).await;
        output
            .write_all(
                format!("{{\"id\":{},\"size\":0,\"handle\":\"2\"}}\n", next["id"]).as_bytes(),
            )
            .await
            .unwrap();
        let _ = input.read(&mut [0]).await;
    });
    let session = Session::new(client).await.unwrap();
    assert_eq!(
        session
            .open("/missing", false)
            .await
            .err()
            .unwrap()
            .to_string(),
        "sftp.compressionWorker"
    );
    assert_eq!(session.open("/present", false).await.unwrap(), "2");
    drop(session);
    fixture.await.unwrap();
}

#[tokio::test]
async fn aborting_read_only_transport_closes_peer_and_releases_unacknowledged_requests() {
    let (client, mut server) = duplex(4096);
    server.write_all(MAGIC).await.unwrap();
    let session = Arc::new(Session::new(client).await.unwrap());
    let mut peer = BufReader::new(server);
    let reading = session.clone();
    let request = tokio::spawn(async move { reading.read("1", 0, 4096).await });
    let mut line = String::new();
    peer.read_line(&mut line).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["op"], "read");
    assert_eq!(session.slots.available_permits(), 63);
    session.abort();
    tokio::time::timeout(Duration::from_millis(500), async {
        assert!(request.await.unwrap().is_err());
        assert_eq!(peer.read(&mut [0]).await.unwrap(), 0);
        assert_eq!(session.slots.available_permits(), 64);
        assert!(session
            .open("/cannot-reuse-aborted-channel", false)
            .await
            .is_err());
    })
    .await
    .expect("interrupted read-only transport retained its peer or requests");
}

#[tokio::test]
async fn archive_upload_waits_for_acknowledgement_and_preserves_member_boundaries() {
    let (client, server) = duplex(1024 * 1024);
    let (ready, waiting) = oneshot::channel();
    let (acknowledge, acknowledged) = oneshot::channel();
    let fixture = tokio::spawn(async move {
        let (input, mut output) = tokio::io::split(server);
        let mut input = BufReader::new(input);
        output.write_all(MAGIC).await.unwrap();
        let request = header(&mut input).await;
        assert_eq!(request["op"], "archive_write");
        assert_eq!(request["entries"][0]["path"], "/owned/文件.part");
        let mut payload = vec![0; request["size"].as_u64().unwrap() as usize];
        input.read_exact(&mut payload).await.unwrap();
        let archive = decode(
            payload,
            request["length"].as_u64().unwrap() as usize,
            request["compressed"].as_bool().unwrap(),
        )
        .unwrap();
        assert_eq!(
            super::super::archive::unpack(archive, &[65536, 0]).unwrap(),
            vec![vec![b'x'; 65536], vec![]]
        );
        ready.send(()).unwrap();
        acknowledged.await.unwrap();
        output
            .write_all(format!("{{\"id\":{},\"size\":0}}\n", request["id"]).as_bytes())
            .await
            .unwrap();
        let _ = input.read(&mut [0]).await;
    });
    let session = Arc::new(Session::new(client).await.unwrap());
    let writing = session.clone();
    let operation = tokio::spawn(async move {
        writing
            .write_archive(
                vec![
                    super::super::archive::Entry {
                        path: "/owned/文件.part".into(),
                        length: 65536,
                    },
                    super::super::archive::Entry {
                        path: "/owned/empty.part".into(),
                        length: 0,
                    },
                ],
                vec![vec![b'x'; 65536], vec![]],
                true,
            )
            .await
    });
    waiting.await.unwrap();
    assert!(
        !operation.is_finished(),
        "archive completion preceded its write acknowledgement"
    );
    acknowledge.send(()).unwrap();
    operation.await.unwrap().unwrap();
    drop(session);
    fixture.await.unwrap();
}

#[tokio::test]
async fn archive_download_rejects_wrong_member_lengths_from_peer() {
    let (client, server) = duplex(1024 * 1024);
    let fixture = tokio::spawn(async move {
        let (input, mut output) = tokio::io::split(server);
        let mut input = BufReader::new(input);
        output.write_all(MAGIC).await.unwrap();
        let request = header(&mut input).await;
        assert_eq!(request["op"], "archive_read");
        let archive = super::super::archive::pack(vec![b"wrong length".to_vec()]).unwrap();
        output
            .write_all(
                format!(
                    "{{\"id\":{},\"size\":{},\"length\":{}}}\n",
                    request["id"],
                    archive.len(),
                    archive.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        output.write_all(&archive).await.unwrap();
        let _ = input.read(&mut [0]).await;
    });
    let session = Session::new(client).await.unwrap();
    assert!(session
        .read_archive(
            vec![super::super::archive::Entry {
                path: "/owned/source".into(),
                length: 4,
            }],
            false
        )
        .await
        .is_err());
    drop(session);
    fixture.await.unwrap();
}

#[tokio::test]
async fn directory_creation_keeps_worker_rejections_distinct_from_lost_replies() {
    let (client, server) = duplex(4096);
    let fixture = tokio::spawn(async move {
        let (input, mut output) = tokio::io::split(server);
        let mut input = BufReader::new(input);
        output.write_all(MAGIC).await.unwrap();
        for rejected in [true, false] {
            let request = header(&mut input).await;
            assert_eq!(request["op"], "mkdir_private");
            let response = json!({"id":request["id"],"size":0,"error":rejected.then_some("permission denied")});
            output
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
        }
    });
    let session = Session::new(client).await.unwrap();
    assert!(matches!(
        session.create_private_directory("/denied").await.unwrap(),
        range_io::DirectoryCreation::Rejected(_)
    ));
    assert!(matches!(
        session.create_private_directory("/allowed").await.unwrap(),
        range_io::DirectoryCreation::Created
    ));
    fixture.await.unwrap();
}
