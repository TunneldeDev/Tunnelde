use super::*;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct Observed {
    data: Vec<u8>,
    writes: Vec<usize>,
    write_status: u32,
    write_gate: Option<Arc<tokio::sync::Semaphore>>,
    mkdir_status: u32,
    reads: Vec<usize>,
    read_offsets: Vec<u64>,
    short_read: Option<usize>,
    read_status: Option<u32>,
    read_gates: std::collections::BTreeMap<u64, Arc<tokio::sync::Semaphore>>,
    pending: usize,
    peak: usize,
    closes: usize,
    disconnected: bool,
    open_gate: Option<Arc<tokio::sync::Semaphore>>,
    reject_open: bool,
    opens: usize,
    open_flags: Vec<u32>,
    copies: Vec<(u64, u64, u64)>,
    copied: Vec<u8>,
}

#[derive(Clone, Default)]
struct CloseReply {
    gate: Option<Arc<tokio::sync::Semaphore>>,
    status: u32,
}

#[derive(Clone, Default)]
struct CopyReply {
    advertised: Option<String>,
    gate: Option<Arc<tokio::sync::Semaphore>>,
    status: u32,
    partial: Option<usize>,
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
    server_with_close(write_limit, delay, CloseReply::default()).await
}

async fn server_with_close(
    write_limit: Option<u64>,
    delay: Duration,
    close: CloseReply,
) -> (Arc<DataSession>, Arc<Mutex<Observed>>) {
    let (client, observed) = stream_with_close(write_limit, delay, close).await;
    (Arc::new(DataSession::new(client).await.unwrap()), observed)
}

async fn stream_with_close(
    write_limit: Option<u64>,
    delay: Duration,
    close: CloseReply,
) -> (tokio::io::DuplexStream, Arc<Mutex<Observed>>) {
    stream_with_copy(write_limit, delay, close, None).await
}

async fn stream_with_copy(
    write_limit: Option<u64>,
    delay: Duration,
    close: CloseReply,
    copy: Option<CopyReply>,
) -> (tokio::io::DuplexStream, Arc<Mutex<Observed>>) {
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
            let mut read_gate = None;
            match kind {
                1 => {
                    reply.push(2);
                    reply.extend_from_slice(&3_u32.to_be_bytes());
                    if write_limit.is_some() {
                        field(&mut reply, b"limits@openssh.com");
                        field(&mut reply, b"1");
                    }
                    if let Some(version) = copy.as_ref().and_then(|v| v.advertised.as_ref()) {
                        field(&mut reply, b"copy-data");
                        field(&mut reply, version.as_bytes());
                    }
                }
                200 => {
                    let mut pos = 5;
                    let name = string(&request, &mut pos);
                    if name == b"limits@openssh.com" {
                        reply.push(201);
                        reply.extend_from_slice(id);
                        for value in [262144_u64, 131072, write_limit.unwrap(), 128] {
                            reply.extend_from_slice(&value.to_be_bytes());
                        }
                    } else {
                        assert_eq!(name, b"copy-data");
                        let copy = copy.as_ref().expect("copy-data must be configured");
                        assert_eq!(string(&request, &mut pos), b"/source");
                        let from = u64::from_be_bytes(request[pos..pos + 8].try_into().unwrap());
                        pos += 8;
                        let length = u64::from_be_bytes(request[pos..pos + 8].try_into().unwrap());
                        pos += 8;
                        assert_eq!(string(&request, &mut pos), b"/target");
                        let to = u64::from_be_bytes(request[pos..pos + 8].try_into().unwrap());
                        pos += 8;
                        assert_eq!(pos, request.len());
                        assert!(length > 0 && length <= 1024 * 1024);
                        {
                            let mut state = state.lock().unwrap();
                            state.copies.push((from, length, to));
                            let count = copy.partial.unwrap_or(length as usize);
                            let data = state.data[from as usize..from as usize + count].to_vec();
                            let size = (to as usize + count).max(state.copied.len());
                            state.copied.resize(size, 0);
                            state.copied[to as usize..to as usize + count].copy_from_slice(&data);
                            state.pending += 1;
                            state.peak = state.peak.max(state.pending);
                        }
                        reply.push(101);
                        reply.extend_from_slice(id);
                        reply.extend_from_slice(&copy.status.to_be_bytes());
                        field(&mut reply, b"copy result");
                        field(&mut reply, b"");
                        if let Some(gate) = &copy.gate {
                            let gate = gate.clone();
                            let send = send.clone();
                            tokio::spawn(async move {
                                let _permit = gate.acquire().await.unwrap();
                                let _ = send.send((reply, true));
                            });
                            continue;
                        }
                        delayed = true;
                    }
                }
                3 => {
                    if state.lock().unwrap().reject_open {
                        reply.push(101);
                        reply.extend_from_slice(id);
                        reply.extend_from_slice(&3_u32.to_be_bytes());
                        field(&mut reply, b"target open denied");
                        field(&mut reply, b"");
                        if send.send((reply, false)).is_err() {
                            break;
                        }
                        continue;
                    }
                    reply.push(102);
                    reply.extend_from_slice(id);
                    let mut pos = 5;
                    let path = string(&request, &mut pos);
                    let flags = u32::from_be_bytes(request[pos..pos + 4].try_into().unwrap());
                    field(&mut reply, if copy.is_some() { &path } else { b"handle" });
                    let gate = {
                        let mut state = state.lock().unwrap();
                        state.opens += 1;
                        state.open_flags.push(flags);
                        state.open_gate.clone()
                    };
                    if let Some(gate) = gate {
                        let send = send.clone();
                        tokio::spawn(async move {
                            let _permit = gate.acquire().await.unwrap();
                            let _ = send.send((reply, false));
                        });
                        continue;
                    }
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
                    read_gate = state.read_gates.get(&(offset as u64)).cloned();
                    if let Some(status) = state.read_status {
                        reply.push(101);
                        reply.extend_from_slice(id);
                        reply.extend_from_slice(&status.to_be_bytes());
                        field(&mut reply, b"sampling read rejected");
                        field(&mut reply, b"");
                        drop(state);
                        let _ = send.send((reply, false));
                        continue;
                    }
                    let end = (offset + length.min(state.short_read.unwrap_or(length)))
                        .min(state.data.len());
                    reply.push(103);
                    reply.extend_from_slice(id);
                    field(&mut reply, &state.data[offset..end]);
                    state.reads.push(length);
                    state.read_offsets.push(offset as u64);
                    state.pending += 1;
                    state.peak = state.peak.max(state.pending);
                    delayed = true;
                }
                4 | 6 => {
                    let write_status = state.lock().unwrap().write_status;
                    reply.push(101);
                    reply.extend_from_slice(id);
                    reply.extend_from_slice(
                        &(if kind == 4 {
                            close.status
                        } else {
                            write_status
                        })
                        .to_be_bytes(),
                    );
                    field(&mut reply, b"");
                    field(&mut reply, b"");
                    if kind == 4 {
                        state.lock().unwrap().closes += 1;
                        if let Some(gate) = &close.gate {
                            let gate = gate.clone();
                            let send = send.clone();
                            tokio::spawn(async move {
                                let _permit = gate.acquire().await.unwrap();
                                let _ = send.send((reply, false));
                            });
                            continue;
                        }
                    }
                    if kind == 6 {
                        let mut pos = 5;
                        let handle = string(&request, &mut pos);
                        let offset =
                            u64::from_be_bytes(request[pos..pos + 8].try_into().unwrap()) as usize;
                        pos += 8;
                        let bytes = string(&request, &mut pos);
                        assert!(bytes.len() <= write_limit.unwrap_or(32768) as usize);
                        let mut state = state.lock().unwrap();
                        read_gate = state.write_gate.clone();
                        let output = if copy.is_some() {
                            assert_eq!(handle, b"/target");
                            &mut state.copied
                        } else {
                            &mut state.data
                        };
                        let size = output.len().max(offset + bytes.len());
                        output.resize(size, 0);
                        output[offset..offset + bytes.len()].copy_from_slice(&bytes);
                        state.writes.push(bytes.len());
                        state.pending += 1;
                        state.peak = state.peak.max(state.pending);
                        delayed = true;
                    }
                }
                14 => {
                    reply.push(101);
                    reply.extend_from_slice(id);
                    reply.extend_from_slice(&state.lock().unwrap().mkdir_status.to_be_bytes());
                    field(&mut reply, b"mkdir result");
                    field(&mut reply, b"");
                }
                _ => panic!("unexpected SFTP request {kind}"),
            }
            if delayed {
                let send = send.clone();
                tokio::spawn(async move {
                    let _permit = match read_gate.as_ref() {
                        Some(gate) => Some(gate.acquire().await.unwrap()),
                        None => None,
                    };
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                    let _ = send.send((reply, true));
                });
            } else if send.send((reply, false)).is_err() {
                break;
            }
        }
        state.lock().unwrap().disconnected = true;
    });
    (client, observed)
}

mod ownership;

/// An opt-in wire-level benchmark isolates local IO from WAN variability. It
/// uses the real range pipeline and verifies every byte outside the timed span.
#[tokio::test]
#[ignore = "local throughput measurement; run explicitly without other compilation or tests"]
async fn local_disk_pipeline_throughput() {
    let root = std::env::temp_dir().join(format!("tunnelde-disk-bench-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir(&root).await.unwrap();
    let bytes: Vec<_> = (0..32 * 1024 * 1024 + 73)
        .map(|n| (n % 251) as u8)
        .collect();
    let local = Endpoint {
        session: None,
        path: display_path(&root.join("local.bin")),
    };
    let remote = remote("benchmark");
    for advertised in [None, Some(131072)] {
        for upload in [true, false] {
            let (channel, observed) = server(advertised, Duration::ZERO).await;
            if !upload {
                observed.lock().unwrap().data = bytes.clone();
            }
            let sessions = Sessions {
                source: (!upload).then(|| channel.clone()),
                target: upload.then_some(channel),
            };
            for run in 0..4 {
                tokio::fs::write(&local.path, if upload { bytes.as_slice() } else { &[] })
                    .await
                    .unwrap();
                let (source, target) = if upload {
                    (&local, &remote)
                } else {
                    (&remote, &local)
                };
                let files = Files::open(&sessions, source, target).await.unwrap();
                let transferred = AtomicU64::new(0);
                let started = std::time::Instant::now();
                files
                    .segment(
                        0..bytes.len() as u64,
                        8,
                        &AtomicBool::new(false),
                        &transferred,
                    )
                    .await
                    .unwrap();
                files.finish(false).await.unwrap();
                let seconds = started.elapsed().as_secs_f64();
                assert_eq!(transferred.load(Ordering::Relaxed), bytes.len() as u64);
                if upload {
                    assert_eq!(observed.lock().unwrap().data, bytes);
                } else {
                    assert_eq!(tokio::fs::read(&local.path).await.unwrap(), bytes);
                }
                println!("disk-bench upload={upload} advertised={advertised:?} run={run} seconds={seconds:.6} mib_s={:.3}", bytes.len() as f64 / 1048576.0 / seconds);
            }
        }
    }
    tokio::fs::remove_file(&local.path).await.unwrap();
    tokio::fs::remove_dir(root).await.unwrap();
}

#[tokio::test]
async fn buffered_download_handles_reordered_replies_and_replays_a_cancelled_window() {
    let root = std::env::temp_dir().join(format!("tunnelde-reordered-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir(&root).await.unwrap();
    let path = root.join("partial.bin");
    let bytes: Vec<_> = (0..2 * 1024 * 1024 + 71).map(|n| (n % 251) as u8).collect();
    let prefix = 19;
    let end = bytes.len() - 23;
    let mut expected = vec![255; bytes.len()];
    expected[..prefix].copy_from_slice(&bytes[..prefix]);
    tokio::fs::write(&path, &expected).await.unwrap();
    let (session, state) = server(Some(131072), Duration::ZERO).await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    {
        let mut state = state.lock().unwrap();
        state.data = bytes.clone();
        state.read_gates.insert(prefix as u64, gate.clone());
    }
    let sessions = Sessions {
        source: Some(session),
        target: None,
    };
    let from = remote("source");
    let to = Endpoint {
        session: None,
        path: display_path(&path),
    };
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    let count = AtomicU64::new(0);
    let cancel = AtomicBool::new(false);
    let (result, ()) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(
            files.segment(prefix as u64..end as u64, 8, &cancel, &count),
            async {
                wait_for(|| count.load(Ordering::Relaxed) > 0).await;
                // A later packet completed while the first remains gated. Cancelling
                // must flush completed data without claiming the window committed.
                cancel.store(true, Ordering::SeqCst);
            }
        )
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap_err().to_string(), CANCELLED);
    assert!(count.load(Ordering::Relaxed) > 0);
    assert!(count.load(Ordering::Relaxed) < (end - prefix) as u64);
    gate.add_permits(1);
    files.finish(false).await.unwrap();
    state.lock().unwrap().read_gates.clear();
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    files
        .segment(
            prefix as u64..end as u64,
            3,
            &AtomicBool::new(false),
            &AtomicU64::new(0),
        )
        .await
        .unwrap();
    files.finish(false).await.unwrap();
    expected[prefix..end].copy_from_slice(&bytes[prefix..end]);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), expected);
    tokio::fs::remove_file(path).await.unwrap();
    tokio::fs::remove_dir(root).await.unwrap();
}

async fn wait_for(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("protocol event did not arrive");
}

async fn copy_server(
    reply: CopyReply,
    close: CloseReply,
) -> (Sessions, Arc<Mutex<Observed>>, Endpoint, Endpoint) {
    let (stream, state) =
        stream_with_copy(None, Duration::from_millis(5), close, Some(reply)).await;
    let channel = Arc::new(DataSession::new(stream).await.unwrap());
    let from = Endpoint {
        session: Some("same-session".into()),
        path: "/source".into(),
    };
    let to = Endpoint {
        session: from.session.clone(),
        path: "/target".into(),
    };
    (
        Sessions {
            source: Some(channel.clone()),
            target: Some(channel),
        },
        state,
        from,
        to,
    )
}

fn copy_supported() -> CopyReply {
    CopyReply {
        advertised: Some("1".into()),
        ..Default::default()
    }
}

#[tokio::test]
async fn server_copy_ignores_network_limits_and_keeps_live_task_limits() {
    for limited in [false, true] {
        let (sessions, observed, from, to) =
            copy_server(copy_supported(), CloseReply::default()).await;
        let bytes: Vec<_> = (0..64 * 1024 + 17).map(|n| (n % 239) as u8).collect();
        observed.lock().unwrap().data = bytes.clone();
        let controller = Arc::new(bandwidth::Controller::default());
        controller.configure(1, 1);
        controller.register("copy");
        if limited {
            controller.set_task("copy", 1).unwrap();
        }
        let files = Files::open(&sessions, &from, &to)
            .await
            .unwrap()
            .with_throttle(bandwidth::Throttle {
                controller: controller.clone(),
                id: "copy".into(),
            });
        let stop = AtomicBool::new(false);
        let count = AtomicU64::new(0);
        let (copied, ()) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(
                files.segment(0..bytes.len() as u64, 3, &stop, &count),
                async {
                    if limited {
                        wait_for(|| !observed.lock().unwrap().copies.is_empty()).await;
                        let copied = observed.lock().unwrap().copied.len();
                        assert!(copied > 0 && copied < bytes.len());
                        // A live task limit must throttle server-side disk IO,
                        // but removing it must not leave the network limit active.
                        controller.set_task("copy", 0).unwrap();
                    }
                }
            )
        })
        .await
        .expect("server-side copy was throttled by a network bandwidth limit");
        copied.unwrap();
        files.finish(false).await.unwrap();
        let state = observed.lock().unwrap();
        assert_eq!(state.copied, bytes);
        assert_eq!(count.load(Ordering::Relaxed), bytes.len() as u64);
        assert!(state.reads.is_empty() && state.writes.is_empty());
        assert_eq!(state.closes, 2);
    }
}

#[tokio::test]
async fn relayed_remote_copy_still_obeys_each_network_limit() {
    for (upload, download) in [(1, 0), (0, 1)] {
        let (sessions, observed, from, to) =
            copy_server(CopyReply::default(), CloseReply::default()).await;
        let bytes: Vec<_> = (0..64 * 1024 + 17).map(|n| (n % 239) as u8).collect();
        observed.lock().unwrap().data = bytes.clone();
        let controller = Arc::new(bandwidth::Controller::default());
        controller.configure(upload, download);
        controller.register("relay");
        let files = Files::open(&sessions, &from, &to)
            .await
            .unwrap()
            .with_throttle(bandwidth::Throttle {
                controller: controller.clone(),
                id: "relay".into(),
            });
        let stop = AtomicBool::new(false);
        let count = AtomicU64::new(0);
        let (copied, ()) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(
                files.segment(0..bytes.len() as u64, 3, &stop, &count),
                async {
                    wait_for(|| !observed.lock().unwrap().reads.is_empty()).await;
                    // The same session without copy-data still relays bytes
                    // through the client, so either network limit must apply.
                    assert!(observed.lock().unwrap().reads[0] <= 103);
                    controller.configure(0, 0);
                }
            )
        })
        .await
        .unwrap();
        copied.unwrap();
        files.finish(false).await.unwrap();
        let state = observed.lock().unwrap();
        assert_eq!(state.copied, bytes);
        assert_eq!(count.load(Ordering::Relaxed), bytes.len() as u64);
        assert!(state.copies.is_empty());
        assert!(!state.reads.is_empty() && !state.writes.is_empty());
        assert_eq!(state.closes, 2);
    }
}

#[tokio::test]
async fn same_channel_copy_uses_bounded_server_ranges_and_preserves_resume_prefix() {
    let (sessions, state, from, to) = copy_server(copy_supported(), CloseReply::default()).await;
    let bytes: Vec<_> = (0..3 * 1024 * 1024 + 51).map(|n| (n % 239) as u8).collect();
    let prefix = 32771;
    {
        let mut state = state.lock().unwrap();
        state.data = bytes.clone();
        state.copied = bytes[..prefix].to_vec();
    }
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    let count = AtomicU64::new(0);
    files
        .segment(
            prefix as u64..bytes.len() as u64,
            3,
            &AtomicBool::new(false),
            &count,
        )
        .await
        .unwrap();
    files.finish(false).await.unwrap();
    let state = state.lock().unwrap();
    assert_eq!(state.copied, bytes);
    assert_eq!(count.load(Ordering::Relaxed), (bytes.len() - prefix) as u64);
    assert_eq!(
        state.open_flags,
        [OpenFlags::READ.bits(), OpenFlags::WRITE.bits()]
    );
    assert!(state.reads.is_empty() && state.writes.is_empty());
    assert_eq!(
        state.copies.len(),
        (bytes.len() - prefix).div_ceil(1024 * 1024)
    );
    assert!(state.copies.iter().all(|(from, length, to)| from == to
        && *from >= prefix as u64
        && *length > 0
        && *length <= 1024 * 1024));
    assert!(state.peak > 1 && state.peak <= 3);
    assert_eq!(state.closes, 2);
}

#[tokio::test]
async fn copy_requires_exact_extension_version_shared_channel_and_matching_session() {
    for advertised in [None, Some("0"), Some("2"), Some("1")] {
        let (sessions, state, from, mut to) = copy_server(
            CopyReply {
                advertised: advertised.map(String::from),
                ..Default::default()
            },
            CloseReply::default(),
        )
        .await;
        state.lock().unwrap().data = b"compatible fallback".to_vec();
        if advertised == Some("1") {
            to.session = Some("another-session".into());
        }
        let files = Files::open(&sessions, &from, &to).await.unwrap();
        assert!(files.server_copy().is_none());
        files
            .segment(0..19, 2, &AtomicBool::new(false), &AtomicU64::new(0))
            .await
            .unwrap();
        files.finish(false).await.unwrap();
        let state = state.lock().unwrap();
        assert_eq!(state.copied, b"compatible fallback");
        assert!(state.copies.is_empty());
        assert!(!state.reads.is_empty() && !state.writes.is_empty());
    }
    let (mut sessions, _, from, to) = copy_server(copy_supported(), CloseReply::default()).await;
    let (other, _) = server(None, Duration::ZERO).await;
    sessions.target = Some(other);
    assert!(!sessions.server_copy());
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    assert!(files.server_copy().is_none());
    files.finish(false).await.unwrap();
}

#[tokio::test]
async fn failed_server_copy_never_falls_back_or_counts_unacknowledged_bytes() {
    let (sessions, state, from, to) = copy_server(
        CopyReply {
            status: 4,
            partial: Some(3),
            ..copy_supported()
        },
        CloseReply::default(),
    )
    .await;
    state.lock().unwrap().data = b"partial mutation".to_vec();
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    let count = AtomicU64::new(0);
    let result = files
        .segment(0..16, 1, &AtomicBool::new(false), &count)
        .await;
    assert!(result.is_err());
    assert_eq!(count.load(Ordering::Relaxed), 0);
    assert!(files.unsettled_write.load(Ordering::SeqCst));
    files.finish(true).await.unwrap();
    let state = state.lock().unwrap();
    assert_eq!(state.copied, b"par");
    assert_eq!(state.copies.len(), 1);
    assert!(state.reads.is_empty() && state.writes.is_empty());
    assert!(!state.disconnected);
    assert_eq!(state.closes, 2);
}

#[tokio::test]
async fn cancelled_server_copy_drains_shared_destination_before_retiring_task() {
    let copy_gate = Arc::new(tokio::sync::Semaphore::new(0));
    let close_gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (sessions, state, from, to) = copy_server(
        CopyReply {
            gate: Some(copy_gate.clone()),
            ..copy_supported()
        },
        CloseReply {
            gate: Some(close_gate.clone()),
            status: 0,
        },
    )
    .await;
    state.lock().unwrap().data = b"pending".to_vec();
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    let cancel = AtomicBool::new(false);
    let count = AtomicU64::new(0);
    let (result, ()) = tokio::time::timeout(Duration::from_millis(500), async {
        tokio::join!(files.segment(0..7, 1, &cancel, &count), async {
            wait_for(|| !state.lock().unwrap().copies.is_empty()).await;
            cancel.store(true, Ordering::SeqCst);
        })
    })
    .await
    .expect("copy cancellation waited for its acknowledgement");
    assert_eq!(result.unwrap_err().to_string(), CANCELLED);
    assert_eq!(count.load(Ordering::Relaxed), 0);
    let finish = files.finish_cancellable(true, &cancel);
    tokio::pin!(finish);
    tokio::select! {
        result = &mut finish => panic!("uncertain copy released before CLOSE: {result:?}"),
        () = wait_for(|| state.lock().unwrap().closes == 2) => {}
    }
    assert!(tokio::time::timeout(Duration::from_millis(40), &mut finish)
        .await
        .is_err());
    assert!(!state.lock().unwrap().disconnected);
    copy_gate.add_permits(1);
    close_gate.add_permits(2);
    finish.await.unwrap();
    let next = Files::open(&sessions, &from, &to).await.unwrap();
    next.segment(0..0, 1, &AtomicBool::new(false), &count)
        .await
        .unwrap();
    close_gate.add_permits(2);
    next.finish(false).await.unwrap();
    assert_eq!(
        state.lock().unwrap().copies.len(),
        1,
        "empty source sent an unbounded copy-to-EOF request"
    );
    assert_eq!(state.lock().unwrap().closes, 4);
}

#[tokio::test]
async fn acknowledged_server_copy_close_is_cancellable_without_aborting_shared_channel() {
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (sessions, state, from, to) = copy_server(
        copy_supported(),
        CloseReply {
            gate: Some(gate.clone()),
            status: 0,
        },
    )
    .await;
    state.lock().unwrap().data = b"done".to_vec();
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    files
        .segment(0..4, 1, &AtomicBool::new(false), &AtomicU64::new(0))
        .await
        .unwrap();
    assert!(!files.unsettled_write.load(Ordering::SeqCst));
    let cancel = AtomicBool::new(false);
    let (result, ()) = tokio::time::timeout(Duration::from_millis(500), async {
        tokio::join!(files.finish_cancellable(false, &cancel), async {
            wait_for(|| state.lock().unwrap().closes == 2).await;
            cancel.store(true, Ordering::SeqCst);
        })
    })
    .await
    .expect("acknowledged copy blocked close cancellation");
    assert_eq!(result.unwrap_err().to_string(), CANCELLED);
    assert!(!state.lock().unwrap().disconnected);
    gate.add_permits(4);
    let next = Files::open(&sessions, &from, &to).await.unwrap();
    next.finish(false).await.unwrap();
}

#[tokio::test]
async fn server_copy_replays_cancelled_window_with_new_limits_and_smaller_segments() {
    let gate = Arc::new(tokio::sync::Semaphore::new(1));
    let (sessions, state, from, to) = copy_server(
        CopyReply {
            gate: Some(gate.clone()),
            ..copy_supported()
        },
        CloseReply::default(),
    )
    .await;
    let bytes: Vec<_> = (0..2 * 1024 * 1024 + 31).map(|n| (n % 239) as u8).collect();
    state.lock().unwrap().data = bytes.clone();
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    let count = AtomicU64::new(0);
    let prefix = 4099;
    files
        .segment(0..prefix, 1, &AtomicBool::new(false), &count)
        .await
        .unwrap();
    // Semaphore permits are returned by the fixture after each ACK.
    gate.acquire().await.unwrap().forget();
    let cancel = AtomicBool::new(false);
    let (result, ()) = tokio::join!(
        files.segment(prefix..bytes.len() as u64, 3, &cancel, &count),
        async {
            wait_for(|| state.lock().unwrap().copies.len() > 1).await;
            cancel.store(true, Ordering::SeqCst);
        }
    );
    assert_eq!(result.unwrap_err().to_string(), CANCELLED);
    assert_eq!(count.load(Ordering::Relaxed), prefix);
    gate.add_permits(4);
    files.finish(true).await.unwrap();
    wait_for(|| state.lock().unwrap().pending == 0).await;
    let controller = Arc::new(bandwidth::Controller::default());
    controller.register("server-replay");
    controller.configure(128, 64);
    let files = Files::open(&sessions, &from, &to)
        .await
        .unwrap()
        .with_throttle(bandwidth::Throttle {
            controller: controller.clone(),
            id: "server-replay".into(),
        });
    let cancel = AtomicBool::new(false);
    let mut progress = 0;
    let (result, ()) = tokio::join!(
        super::super::segments::copy_window(
            &files,
            prefix..bytes.len() as u64,
            super::super::segments::Plan {
                workers: 2,
                chunk: 16384,
                requests: 2
            },
            &cancel,
            |bytes| progress += bytes,
        ),
        async {
            tokio::time::sleep(Duration::from_millis(80)).await;
            controller.configure(0, 0);
        }
    );
    result.unwrap();
    files.finish(false).await.unwrap();
    let state = state.lock().unwrap();
    assert_eq!(state.copied, bytes);
    assert_eq!(progress, bytes.len() as u64 - prefix);
    assert!(state.reads.is_empty() && state.writes.is_empty());
}

#[tokio::test]
async fn cancelled_data_open_stops_without_waiting_for_handle_reply_or_aborting_other_writers() {
    let (target, observed) = server(None, Duration::ZERO).await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    observed.lock().unwrap().open_gate = Some(gate.clone());
    let sessions = Sessions {
        source: None,
        target: Some(target),
    };
    let from = remote("unused-local-source");
    let to = remote("target");
    let cancel = AtomicBool::new(false);
    let (result, ()) = tokio::time::timeout(Duration::from_millis(500), async {
        tokio::join!(
            Files::open_cancellable(&sessions, &from, &to, &cancel),
            async {
                wait_for(|| observed.lock().unwrap().opens == 1).await;
                cancel.store(true, Ordering::SeqCst);
            }
        )
    })
    .await
    .unwrap();
    assert_eq!(result.err().unwrap().to_string(), CANCELLED);
    assert!(!observed.lock().unwrap().disconnected);
    assert!(observed.lock().unwrap().writes.is_empty());
    gate.add_permits(1);
    observed.lock().unwrap().open_gate = None;
    let next = Files::open(&sessions, &from, &to).await.unwrap();
    next.finish(false).await.unwrap();
    assert!(!observed.lock().unwrap().disconnected);
}

fn remote(name: &str) -> Endpoint {
    Endpoint {
        session: Some(name.into()),
        path: format!("/{name}"),
    }
}

#[tokio::test]
async fn failed_target_open_closes_source_and_preserves_error_when_cleanup_is_cancelled() {
    for cancel_cleanup in [false, true] {
        let close_gate = Arc::new(tokio::sync::Semaphore::new(0));
        let (source, input) = server_with_close(
            None,
            Duration::ZERO,
            CloseReply {
                gate: Some(close_gate.clone()),
                ..Default::default()
            },
        )
        .await;
        let (target, output) = server(None, Duration::ZERO).await;
        output.lock().unwrap().reject_open = true;
        let expected = target.open("/target", true).await.unwrap_err().to_string();
        let sessions = Sessions {
            source: Some(source),
            target: Some(target),
        };
        let from = remote("source");
        let to = remote("target");
        let cancel = AtomicBool::new(false);
        let operation = Files::open_cancellable(&sessions, &from, &to, &cancel);
        tokio::pin!(operation);
        tokio::select! {
            result = &mut operation => panic!("source CLOSE was not awaited: {:?}", result.err()),
            () = wait_for(|| input.lock().unwrap().closes == 1) => {}
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut operation)
                .await
                .is_err()
        );
        if cancel_cleanup {
            cancel.store(true, Ordering::SeqCst);
        } else {
            close_gate.add_permits(1);
        }
        let error = tokio::time::timeout(Duration::from_millis(500), &mut operation)
            .await
            .expect("source cleanup ignored cancellation")
            .err()
            .unwrap();
        assert_eq!(error.to_string(), expected);
        assert!(!input.lock().unwrap().disconnected);
        assert!(input.lock().unwrap().writes.is_empty());
        close_gate.add_permits(1);
    }
}

#[tokio::test]
async fn cancelled_target_open_does_not_wait_for_source_close_or_abort_shared_channels() {
    let close_gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (source, input) = server_with_close(
        None,
        Duration::ZERO,
        CloseReply {
            gate: Some(close_gate.clone()),
            ..Default::default()
        },
    )
    .await;
    let (target, output) = server(None, Duration::ZERO).await;
    let open_gate = Arc::new(tokio::sync::Semaphore::new(0));
    output.lock().unwrap().open_gate = Some(open_gate.clone());
    let sessions = Sessions {
        source: Some(source),
        target: Some(target),
    };
    let from = remote("source");
    let to = remote("target");
    let cancel = AtomicBool::new(false);
    let (result, ()) = tokio::time::timeout(Duration::from_millis(500), async {
        tokio::join!(
            Files::open_cancellable(&sessions, &from, &to, &cancel),
            async {
                wait_for(|| output.lock().unwrap().opens == 1).await;
                assert_eq!(input.lock().unwrap().opens, 1);
                cancel.store(true, Ordering::SeqCst);
            }
        )
    })
    .await
    .expect("pause waited for source CLOSE after cancelling target OPEN");
    assert_eq!(result.err().unwrap().to_string(), CANCELLED);
    assert!(!input.lock().unwrap().disconnected);
    assert!(!output.lock().unwrap().disconnected);
    assert!(input.lock().unwrap().writes.is_empty());
    assert!(output.lock().unwrap().writes.is_empty());
    // Neither the cancelled read-only open nor its late reply can create or
    // truncate data. Other directory workers keep their shared channels.
    open_gate.add_permits(1);
    output.lock().unwrap().open_gate = None;
    close_gate.add_permits(2);
    let next = Files::open(&sessions, &from, &to).await.unwrap();
    next.finish(false).await.unwrap();
}

#[tokio::test]
async fn cancelled_download_closes_source_channel_without_waiting_for_read_or_close_reply() {
    let (session, observed) = server_with_close(
        Some(131072),
        Duration::from_secs(30),
        CloseReply {
            gate: Some(Arc::new(tokio::sync::Semaphore::new(0))),
            ..Default::default()
        },
    )
    .await;
    observed.lock().unwrap().data = vec![1; 1024 * 1024];
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.tmp/qa")
        .join(format!("sftp-cancel-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let destination = root.join("destination.bin");
    let partial = root.join("destination.part");
    tokio::fs::write(&destination, b"original destination")
        .await
        .unwrap();
    tokio::fs::write(&partial, b"confirmed prefix")
        .await
        .unwrap();
    let from = remote("source");
    let to = Endpoint {
        session: None,
        path: display_path(&partial),
    };
    let sessions = Sessions {
        source: Some(session),
        target: None,
    };
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    let stop = AtomicBool::new(false);
    let count = AtomicU64::new(0);
    let (result, ()) = tokio::time::timeout(Duration::from_millis(500), async {
        tokio::join!(files.segment(16..1024 * 1024, 8, &stop, &count), async {
            wait_for(|| !observed.lock().unwrap().reads.is_empty()).await;
            stop.store(true, Ordering::SeqCst);
        })
    })
    .await
    .expect("cancel waited for a read acknowledgement");
    assert!(result.is_err());
    tokio::time::timeout(Duration::from_millis(500), files.finish(true))
        .await
        .expect("cancel waited for a source CLOSE acknowledgement")
        .unwrap();
    wait_for(|| observed.lock().unwrap().disconnected).await;
    assert_eq!(observed.lock().unwrap().closes, 0);
    assert_eq!(count.load(Ordering::Relaxed), 0);
    assert_eq!(
        tokio::fs::read(&partial).await.unwrap(),
        b"confirmed prefix"
    );
    // All local segment writers have been dropped and the original stays intact.
    tokio::fs::remove_file(&partial).await.unwrap();
    assert_eq!(
        tokio::fs::read(&destination).await.unwrap(),
        b"original destination"
    );
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn interrupted_remote_copy_still_waits_for_destination_close_and_reports_failure() {
    let (source, input) = server(None, Duration::ZERO).await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (target, output) = server_with_close(
        None,
        Duration::ZERO,
        CloseReply {
            gate: Some(gate.clone()),
            status: 4,
        },
    )
    .await;
    let sessions = Sessions {
        source: Some(source),
        target: Some(target),
    };
    let from = remote("source");
    let to = remote("target");
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    let finish = files.finish(true);
    tokio::pin!(finish);
    tokio::select! {
        result = &mut finish => panic!("destination CLOSE was not awaited: {result:?}"),
        () = wait_for(|| output.lock().unwrap().closes == 1) => {}
    }
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut finish)
        .await
        .is_err());
    wait_for(|| input.lock().unwrap().disconnected).await;
    gate.add_permits(1);
    assert!(
        finish.await.is_err(),
        "destination CLOSE failure was swallowed"
    );
}

#[tokio::test]
async fn interrupted_copy_does_not_abort_a_source_channel_shared_with_its_writer() {
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (session, observed) = server_with_close(
        None,
        Duration::ZERO,
        CloseReply {
            gate: Some(gate.clone()),
            ..Default::default()
        },
    )
    .await;
    let sessions = Sessions {
        source: Some(session.clone()),
        target: Some(session),
    };
    let from = remote("source");
    let to = remote("target");
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    let finish = files.finish(true);
    tokio::pin!(finish);
    tokio::select! {
        result = &mut finish => panic!("shared writer channel was aborted: {result:?}"),
        () = wait_for(|| observed.lock().unwrap().closes == 2) => {}
    }
    assert!(!observed.lock().unwrap().disconnected);
    gate.add_permits(2);
    finish.await.unwrap();
    let handle = sessions
        .target
        .as_ref()
        .unwrap()
        .open("/still-usable", true)
        .await
        .unwrap();
    gate.add_permits(1);
    sessions
        .target
        .as_ref()
        .unwrap()
        .close(&handle)
        .await
        .unwrap();
}

#[tokio::test]
async fn completed_copy_waits_for_both_close_replies_and_reuses_its_channels() {
    let source_gate = Arc::new(tokio::sync::Semaphore::new(0));
    let target_gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (source, input) = server_with_close(
        None,
        Duration::ZERO,
        CloseReply {
            gate: Some(source_gate.clone()),
            ..Default::default()
        },
    )
    .await;
    let (target, output) = server_with_close(
        None,
        Duration::ZERO,
        CloseReply {
            gate: Some(target_gate.clone()),
            ..Default::default()
        },
    )
    .await;
    let sessions = Sessions {
        source: Some(source),
        target: Some(target),
    };
    let from = remote("source");
    let to = remote("target");
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    let finish = files.finish(false);
    tokio::pin!(finish);
    tokio::select! {
        result = &mut finish => panic!("successful copy skipped CLOSE: {result:?}"),
        () = wait_for(|| input.lock().unwrap().closes == 1 && output.lock().unwrap().closes == 1) => {}
    }
    source_gate.add_permits(1);
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut finish)
        .await
        .is_err());
    target_gate.add_permits(1);
    finish.await.unwrap();
    assert!(!input.lock().unwrap().disconnected);
    assert!(!output.lock().unwrap().disconnected);
    let next = Files::open(&sessions, &from, &to).await.unwrap();
    source_gate.add_permits(1);
    target_gate.add_permits(1);
    next.finish(false).await.unwrap();
}

#[tokio::test]
async fn empty_staging_close_cancels_without_duplicate_close_or_disconnecting_metadata() {
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (stream, observed) = stream_with_close(
        None,
        Duration::ZERO,
        CloseReply {
            gate: Some(gate.clone()),
            ..Default::default()
        },
    )
    .await;
    let session = SftpSession::new(stream).await.unwrap();
    let writer = Writer::Remote(Box::new(
        session
            .open_with_flags("/staging", OpenFlags::WRITE)
            .await
            .unwrap(),
    ));
    let cancel = AtomicBool::new(false);
    let (result, ()) = tokio::time::timeout(Duration::from_millis(500), async {
        tokio::join!(writer.finish_empty(&cancel), async {
            wait_for(|| observed.lock().unwrap().closes == 1).await;
            cancel.store(true, Ordering::SeqCst);
        })
    })
    .await
    .expect("pause waited for empty staging CLOSE");
    assert_eq!(result.unwrap_err().to_string(), CANCELLED);
    assert!(observed.lock().unwrap().writes.is_empty());
    assert!(!observed.lock().unwrap().disconnected);
    gate.add_permits(1);
    let mut next = session
        .open_with_flags("/another-file", OpenFlags::WRITE)
        .await
        .unwrap();
    next.write_all(b"still usable").await.unwrap();
    next.flush().await.unwrap();
    assert_eq!(observed.lock().unwrap().data, b"still usable");
    gate.add_permits(1);
    next.close().await.unwrap();
    assert_eq!(
        observed.lock().unwrap().closes,
        2,
        "abandoned CLOSE was sent twice"
    );
}

#[tokio::test]
async fn acknowledged_writes_allow_prompt_close_cancellation_and_shared_channel_reuse() {
    let source_gate = Arc::new(tokio::sync::Semaphore::new(0));
    let target_gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (source, input) = server_with_close(
        None,
        Duration::ZERO,
        CloseReply {
            gate: Some(source_gate.clone()),
            ..Default::default()
        },
    )
    .await;
    let (target, output) = server_with_close(
        None,
        Duration::ZERO,
        CloseReply {
            gate: Some(target_gate.clone()),
            ..Default::default()
        },
    )
    .await;
    let bytes = b"all destination writes acknowledged";
    input.lock().unwrap().data = bytes.to_vec();
    let sessions = Sessions {
        source: Some(source),
        target: Some(target),
    };
    let from = remote("source");
    let to = remote("target");
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    files
        .segment(
            0..bytes.len() as u64,
            4,
            &AtomicBool::new(false),
            &AtomicU64::new(0),
        )
        .await
        .unwrap();
    let cancel = AtomicBool::new(false);
    let (result, ()) = tokio::time::timeout(Duration::from_millis(500), async {
        tokio::join!(files.finish_cancellable(false, &cancel), async {
            wait_for(|| input.lock().unwrap().closes == 1 && output.lock().unwrap().closes == 1)
                .await;
            cancel.store(true, Ordering::SeqCst);
        })
    })
    .await
    .expect("pause waited for acknowledged data CLOSE");
    assert_eq!(result.unwrap_err().to_string(), CANCELLED);
    assert_eq!(output.lock().unwrap().data, bytes);
    assert!(!input.lock().unwrap().disconnected);
    assert!(!output.lock().unwrap().disconnected);
    source_gate.add_permits(2);
    target_gate.add_permits(2);
    let next = Files::open(&sessions, &from, &to).await.unwrap();
    next.finish_cancellable(false, &AtomicBool::new(false))
        .await
        .unwrap();
    assert_eq!(input.lock().unwrap().closes, 2);
    assert_eq!(output.lock().unwrap().closes, 2);
    assert_eq!(output.lock().unwrap().data, bytes);
}

#[tokio::test]
async fn unacknowledged_write_keeps_destination_close_drain_even_when_cancelled() {
    let (source, input) = server(None, Duration::ZERO).await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (target, output) = server_with_close(
        None,
        Duration::from_secs(30),
        CloseReply {
            gate: Some(gate.clone()),
            status: 4,
        },
    )
    .await;
    input.lock().unwrap().data = b"pending write".to_vec();
    let sessions = Sessions {
        source: Some(source),
        target: Some(target),
    };
    let from = remote("source");
    let to = remote("target");
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    let cancel = AtomicBool::new(false);
    let transferred = AtomicU64::new(0);
    let (copied, ()) = tokio::time::timeout(Duration::from_millis(500), async {
        tokio::join!(files.segment(0..13, 1, &cancel, &transferred), async {
            wait_for(|| !output.lock().unwrap().writes.is_empty()).await;
            cancel.store(true, Ordering::SeqCst);
        })
    })
    .await
    .expect("WRITE cancellation blocked");
    assert_eq!(copied.unwrap_err().to_string(), CANCELLED);
    let finish = files.finish_cancellable(true, &cancel);
    tokio::pin!(finish);
    tokio::select! {
        result = &mut finish => panic!("unacknowledged writer was released: {result:?}"),
        () = wait_for(|| output.lock().unwrap().closes == 1) => {}
    }
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut finish)
        .await
        .is_err());
    gate.add_permits(1);
    assert_ne!(
        finish.await.unwrap_err().to_string(),
        CANCELLED,
        "CLOSE failure was swallowed by cancellation"
    );
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
    files.finish(false).await.unwrap();
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
async fn replay_rewrites_a_sparse_tail_without_exceeding_new_request_and_worker_limits() {
    use crate::ssh::files::segments::{self, Plan};
    let bytes: Vec<u8> = (0..2 * 1024 * 1024 + 71).map(|n| (n % 251) as u8).collect();
    let prefix = 32768;
    for workers in [1, 2, 3] {
        let (source, input) = server(Some(131072), Duration::from_millis(2)).await;
        let (target, output) = server(Some(131072), Duration::from_millis(10)).await;
        input.lock().unwrap().data = bytes.clone();
        let mut partial = vec![0; bytes.len() - 30];
        partial[..prefix].copy_from_slice(&bytes[..prefix]);
        partial[prefix..prefix + 31].fill(255);
        output.lock().unwrap().data = partial;
        let sessions = Sessions {
            source: Some(source),
            target: Some(target),
        };
        let from = remote("source");
        let to = remote("target");
        let files = Files::open(&sessions, &from, &to).await.unwrap();
        let plan = Plan {
            workers,
            chunk: 16384,
            requests: 2,
        };
        let mut progress = 0;
        // Much larger than chunk * workers, as when options change on Resume.
        segments::copy_window(
            &files,
            prefix as u64..bytes.len() as u64,
            plan,
            &AtomicBool::new(false),
            |count| progress += count,
        )
        .await
        .unwrap();
        files.finish(false).await.unwrap();
        assert_eq!(output.lock().unwrap().data, bytes);
        assert_eq!(progress, (bytes.len() - prefix) as u64);
        assert!(input.lock().unwrap().peak <= workers * plan.requests);
        assert!(output.lock().unwrap().peak <= workers * plan.requests);
        // The wire fixture rejects any SETSTAT or other unimplemented request.
    }
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
    files.finish(false).await.unwrap();
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
    cancel_pending_requests(false).await;
}

#[tokio::test]
async fn cancellation_interrupts_a_pending_budget_and_remote_request_together() {
    cancel_pending_requests(true).await;
}

async fn cancel_pending_requests(limited: bool) {
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
    let mut files = Files::open(&sessions, &from, &to).await.unwrap();
    if limited {
        let controller = Arc::new(bandwidth::Controller::default());
        controller.register("cancel");
        controller.configure(1, 0);
        files = files.with_throttle(bandwidth::Throttle {
            controller,
            id: "cancel".into(),
        });
    }
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
    files.finish(false).await.unwrap();
}

async fn limited_transfer(upload: bool) {
    let (session, state) = server(Some(131072), Duration::from_millis(60)).await;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.tmp/qa")
        .join(format!("sftp-limited-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let bytes: Vec<u8> = (0..2 * 1024 * 1024 + 71).map(|n| (n % 251) as u8).collect();
    let local = Endpoint {
        session: None,
        path: display_path(&root.join("payload.bin")),
    };
    let remote = Endpoint {
        session: Some("mock".into()),
        path: "/payload.bin".into(),
    };
    tokio::fs::write(&local.path, if upload { bytes.as_slice() } else { &[] })
        .await
        .unwrap();
    if !upload {
        state.lock().unwrap().data = bytes.clone();
    }
    let sessions = Sessions {
        source: (!upload).then(|| session.clone()),
        target: upload.then_some(session),
    };
    let (source, target) = if upload {
        (&local, &remote)
    } else {
        (&remote, &local)
    };
    let controller = Arc::new(bandwidth::Controller::default());
    controller.register("limited");
    controller.configure(16384, 16384);
    // Small grants exercise offsets and keep local input intact when a packet
    // completes while the next preparation is still waiting for credit.
    controller.set_task("limited", 4096).unwrap();
    let files = Files::open(&sessions, source, target)
        .await
        .unwrap()
        .with_throttle(bandwidth::Throttle {
            controller,
            id: "limited".into(),
        });
    let count = AtomicU64::new(0);
    files
        .segment(0..bytes.len() as u64, 8, &AtomicBool::new(false), &count)
        .await
        .unwrap();
    files.finish(false).await.unwrap();
    if upload {
        assert_eq!(state.lock().unwrap().data, bytes);
    } else {
        assert_eq!(tokio::fs::read(&local.path).await.unwrap(), bytes);
    }
    assert_eq!(count.load(Ordering::Relaxed), bytes.len() as u64);
    let peak = state.lock().unwrap().peak;
    tokio::fs::remove_dir_all(root).await.unwrap();
    assert!(
        peak > 1 && peak <= 8,
        "limited transfer serialized requests: peak={peak}"
    );
}

#[tokio::test]
async fn limited_upload_keeps_requests_in_flight_while_waiting_for_budget() {
    limited_transfer(true).await;
}

#[tokio::test]
async fn limited_download_keeps_requests_in_flight_while_waiting_for_budget() {
    limited_transfer(false).await;
}

#[tokio::test]
async fn changing_a_limit_during_io_keeps_remote_copy_offsets_and_bytes() {
    let (source_session, input) = server(Some(131072), Duration::from_millis(60)).await;
    let (target_session, output) = server(Some(65536), Duration::from_millis(40)).await;
    let bytes: Vec<u8> = (0..1024 * 1024 + 53).map(|n| (n % 239) as u8).collect();
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
    let controller = Arc::new(bandwidth::Controller::default());
    controller.register("changing");
    controller.configure(128, 64);
    let files = Files::open(&sessions, &from, &to)
        .await
        .unwrap()
        .with_throttle(bandwidth::Throttle {
            controller: controller.clone(),
            id: "changing".into(),
        });
    let count = AtomicU64::new(0);
    let stop = AtomicBool::new(false);
    let (result, ()) = tokio::join!(
        files.segment(0..bytes.len() as u64, 8, &stop, &count),
        async {
            tokio::time::sleep(Duration::from_millis(150)).await;
            controller.configure(16384, 16384);
            tokio::time::sleep(Duration::from_millis(40)).await;
            controller.configure(0, 0);
        }
    );
    result.unwrap();
    files.finish(false).await.unwrap();
    assert_eq!(output.lock().unwrap().data, bytes);
    assert_eq!(count.load(Ordering::Relaxed), bytes.len() as u64);
    assert!(input.lock().unwrap().peak > 1);
    assert!(output.lock().unwrap().peak <= 8);
}

#[tokio::test]
async fn sampling_reads_only_requested_regions_and_closes_before_reuse() {
    let (channel, observed) = server(None, Duration::ZERO).await;
    let data: Vec<_> = (0..2 * 1024 * 1024 + 73).map(|n| (n % 251) as u8).collect();
    observed.lock().unwrap().data = data.clone();
    let reader = SampleReader::open(&channel, "/source").await.unwrap();
    for offset in [0, (data.len() - 16384) / 2, data.len() - 16384] {
        assert_eq!(
            reader.region(offset as u64, 16384).await.unwrap(),
            data[offset..offset + 16384]
        );
    }
    reader.finish().await.unwrap();
    {
        let state = observed.lock().unwrap();
        assert_eq!(state.reads, [16384; 3]);
        assert_eq!(
            state.read_offsets,
            [
                0,
                ((data.len() - 16384) / 2) as u64,
                (data.len() - 16384) as u64
            ]
        );
        assert_eq!(state.closes, 1);
        assert!(!state.disconnected);
        assert_eq!(state.open_flags, [OpenFlags::READ.bits()]);
    }
    let next = channel.open("/source", false).await.unwrap();
    channel.close(&next).await.unwrap();
}

#[tokio::test]
async fn sampling_handles_short_reads_without_prefetching_or_exceeding_region() {
    let (channel, observed) = server(None, Duration::ZERO).await;
    {
        let mut state = observed.lock().unwrap();
        state.data = vec![7; 65536];
        state.short_read = Some(997);
    }
    let reader = SampleReader::open(&channel, "/source").await.unwrap();
    assert_eq!(reader.region(123, 16384).await.unwrap(), vec![7; 16384]);
    reader.finish().await.unwrap();
    let state = observed.lock().unwrap();
    for (&offset, &length) in state.read_offsets.iter().zip(&state.reads) {
        assert_eq!(offset + length as u64, 123 + 16384);
    }
    assert_eq!(state.closes, 1);
}

#[tokio::test]
async fn sampling_rejected_reads_close_the_read_handle() {
    let (channel, observed) = server(None, Duration::ZERO).await;
    {
        let mut state = observed.lock().unwrap();
        state.data = vec![7; 65536];
        state.read_status = Some(3);
    }
    let reader = SampleReader::open(&channel, "/source").await.unwrap();
    assert!(reader.region(0, 16384).await.is_err());
    reader.finish().await.unwrap();
    assert_eq!(observed.lock().unwrap().closes, 1);
}

#[tokio::test]
async fn sampling_cancellation_closes_channel_during_open_read_and_close() {
    for stage in ["open", "read", "close"] {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let (channel, observed) = server_with_close(
            None,
            Duration::ZERO,
            CloseReply {
                gate: (stage == "close").then(|| gate.clone()),
                status: 0,
            },
        )
        .await;
        {
            let mut state = observed.lock().unwrap();
            state.data = vec![7; 65536];
            if stage == "open" {
                state.open_gate = Some(gate.clone());
            }
            if stage == "read" {
                state.read_gates.insert(0, gate.clone());
            }
        }
        let source = channel.clone();
        let task = tokio::spawn(async move {
            let reader = SampleReader::open(&source, "/source").await.unwrap();
            reader.region(0, 16384).await.unwrap();
            reader.finish().await.unwrap();
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let ready = {
                    let state = observed.lock().unwrap();
                    match stage {
                        "open" => state.opens == 1,
                        "read" => !state.reads.is_empty(),
                        _ => state.closes == 1,
                    }
                };
                if ready {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), async {
            while !observed.lock().unwrap().disconnected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        gate.add_permits(1);
    }
}

#[tokio::test]
async fn sampling_rejected_close_discards_channel_instead_of_reusing_handle() {
    let (channel, observed) = server_with_close(
        None,
        Duration::ZERO,
        CloseReply {
            gate: None,
            status: 4,
        },
    )
    .await;
    let reader = SampleReader::open(&channel, "/source").await.unwrap();
    assert!(reader.finish().await.is_err());
    tokio::time::timeout(Duration::from_secs(2), async {
        while !observed.lock().unwrap().disconnected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
