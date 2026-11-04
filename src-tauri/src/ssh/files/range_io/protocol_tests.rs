use super::*;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct Observed {
    data: Vec<u8>,
    writes: Vec<usize>,
    reads: Vec<usize>,
    pending: usize,
    peak: usize,
}

fn string(bytes: &[u8], offset: &mut usize) -> Vec<u8> {
    let size = u32::from_be_bytes(bytes[*offset..*offset + 4].try_into().unwrap()) as usize;
    *offset += 4;
    let result = bytes[*offset..*offset + size].to_vec();
    *offset += size;
    result
}

fn field(output: &mut Vec<u8>, bytes: &[u8]) {
    output.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    output.extend_from_slice(bytes);
}

/// Wire-level SFTP fixture: independent delayed acknowledgements exercise real
/// request pipelining without changing a machine's network or SSH service.
async fn server(
    write_limit: Option<u64>,
    delay: Duration,
) -> (Arc<DataSession>, Arc<Mutex<Observed>>) {
    let (client, server) = tokio::io::duplex(1024 * 1024);
    let observed = Arc::new(Mutex::new(Observed::default()));
    let state = observed.clone();
    let (mut input, mut output) = tokio::io::split(server);
    let (send, mut replies) = tokio::sync::mpsc::unbounded_channel::<(Vec<u8>, bool)>();
    let acknowledgements = state.clone();
    tokio::spawn(async move {
        while let Some((reply, data)) = replies.recv().await {
            if output.write_u32(reply.len() as u32).await.is_err()
                || output.write_all(&reply).await.is_err()
            {
                break;
            }
            if data {
                acknowledgements.lock().unwrap().pending -= 1;
            }
        }
    });
    tokio::spawn(async move {
        while let Ok(size) = input.read_u32().await {
            let mut request = vec![0; size as usize];
            if input.read_exact(&mut request).await.is_err() {
                break;
            }
            let kind = request[0];
            let id = &request[1..5];
            let mut reply = Vec::new();
            let mut delayed = false;
            match kind {
                1 => {
                    reply.push(2);
                    reply.extend_from_slice(&3_u32.to_be_bytes());
                    if write_limit.is_some() {
                        field(&mut reply, b"limits@openssh.com");
                        field(&mut reply, b"1");
                    }
                }
                200 => {
                    reply.push(201);
                    reply.extend_from_slice(id);
                    for value in [262144_u64, 131072, write_limit.unwrap(), 128] {
                        reply.extend_from_slice(&value.to_be_bytes());
                    }
                }
                3 => {
                    reply.push(102);
                    reply.extend_from_slice(id);
                    field(&mut reply, b"handle");
                }
                5 => {
                    let mut pos = 5;
                    let _ = string(&request, &mut pos);
                    let offset =
                        u64::from_be_bytes(request[pos..pos + 8].try_into().unwrap()) as usize;
                    pos += 8;
                    let length =
                        u32::from_be_bytes(request[pos..pos + 4].try_into().unwrap()) as usize;
                    let mut state = state.lock().unwrap();
                    assert!(offset < state.data.len());
                    let end = (offset + length).min(state.data.len());
                    reply.push(103);
                    reply.extend_from_slice(id);
                    field(&mut reply, &state.data[offset..end]);
                    state.reads.push(length);
                    state.pending += 1;
                    state.peak = state.peak.max(state.pending);
                    delayed = true;
                }
                4 | 6 => {
                    reply.push(101);
                    reply.extend_from_slice(id);
                    reply.extend_from_slice(&0_u32.to_be_bytes());
                    field(&mut reply, b"");
                    field(&mut reply, b"");
                    if kind == 6 {
                        let mut pos = 5;
                        let _ = string(&request, &mut pos);
                        let offset =
                            u64::from_be_bytes(request[pos..pos + 8].try_into().unwrap()) as usize;
                        pos += 8;
                        let bytes = string(&request, &mut pos);
                        assert!(bytes.len() <= write_limit.unwrap_or(32768) as usize);
                        let mut state = state.lock().unwrap();
                        let size = state.data.len().max(offset + bytes.len());
                        state.data.resize(size, 0);
                        state.data[offset..offset + bytes.len()].copy_from_slice(&bytes);
                        state.writes.push(bytes.len());
                        state.pending += 1;
                        state.peak = state.peak.max(state.pending);
                        delayed = true;
                    }
                }
                _ => panic!("unexpected SFTP request {kind}"),
            }
            if delayed {
                let send = send.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    let _ = send.send((reply, true));
                });
            } else if send.send((reply, false)).is_err() {
                break;
            }
        }
    });
    (Arc::new(DataSession::new(client).await.unwrap()), observed)
}

#[tokio::test]
async fn upload_uses_advertised_write_limit_and_keeps_a_bounded_pipeline() {
    let (session, state) = server(Some(131072), Duration::from_millis(15)).await;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.tmp/qa")
        .join(format!("sftp-wire-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let bytes: Vec<u8> = (0..2 * 1024 * 1024 + 71).map(|n| (n % 251) as u8).collect();
    let source = Endpoint {
        session: None,
        path: display_path(&root.join("payload.bin")),
    };
    let target = Endpoint {
        session: Some("mock".into()),
        path: "/payload.bin".into(),
    };
    tokio::fs::write(&source.path, &bytes).await.unwrap();
    let sessions = Sessions {
        source: None,
        target: Some(session),
    };
    let files = Files::open(&sessions, &source, &target).await.unwrap();
    let count = AtomicU64::new(0);
    files
        .segment(0..bytes.len() as u64, 8, &AtomicBool::new(false), &count)
        .await
        .unwrap();
    files.close().await.unwrap();
    {
        let observed = state.lock().unwrap();
        assert_eq!(observed.data, bytes);
        assert_eq!(count.load(Ordering::Relaxed), bytes.len() as u64);
        assert_eq!(observed.writes.len(), bytes.len().div_ceil(131072));
        assert_eq!(observed.writes[0], 131072);
        assert!(observed.peak > 1 && observed.peak <= 8);
    }
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn unadvertised_servers_keep_compatible_write_packets() {
    let (session, _) = server(None, Duration::ZERO).await;
    assert_eq!(session.write_size, 32768);
}

#[tokio::test]
async fn remote_copy_respects_both_servers_and_preserves_offsets() {
    let (source_session, input) = server(Some(131072), Duration::from_millis(10)).await;
    let (target_session, output) = server(Some(65536), Duration::from_millis(10)).await;
    let bytes: Vec<u8> = (0..1024 * 1024 + 51).map(|n| (n % 239) as u8).collect();
    input.lock().unwrap().data = bytes.clone();
    let sessions = Sessions {
        source: Some(source_session),
        target: Some(target_session),
    };
    let from = Endpoint {
        session: Some("source".into()),
        path: "/source".into(),
    };
    let to = Endpoint {
        session: Some("target".into()),
        path: "/target".into(),
    };
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    let count = AtomicU64::new(0);
    files
        .segment(0..bytes.len() as u64, 8, &AtomicBool::new(false), &count)
        .await
        .unwrap();
    files.close().await.unwrap();
    assert_eq!(output.lock().unwrap().data, bytes);
    assert!(input
        .lock()
        .unwrap()
        .reads
        .iter()
        .all(|size| *size <= 65536));
    assert_eq!(count.load(Ordering::Relaxed), bytes.len() as u64);
}

#[tokio::test]
async fn cancellation_interrupts_pending_remote_requests() {
    let (source_session, input) = server(Some(131072), Duration::from_secs(1)).await;
    input.lock().unwrap().data = vec![1; 1024 * 1024];
    let (target_session, _) = server(Some(131072), Duration::ZERO).await;
    let sessions = Sessions {
        source: Some(source_session),
        target: Some(target_session),
    };
    let from = Endpoint {
        session: Some("source".into()),
        path: "/source".into(),
    };
    let to = Endpoint {
        session: Some("target".into()),
        path: "/target".into(),
    };
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    let stop = AtomicBool::new(false);
    let count = AtomicU64::new(0);
    let (result, _) = tokio::time::timeout(Duration::from_millis(500), async {
        tokio::join!(files.segment(0..1024 * 1024, 8, &stop, &count), async {
            tokio::time::sleep(Duration::from_millis(25)).await;
            stop.store(true, Ordering::SeqCst);
        })
    })
    .await
    .expect("cancellation waited for server acknowledgement");
    assert!(result.is_err());
    assert_eq!(count.load(Ordering::Relaxed), 0);
    files.close().await.unwrap();
}
