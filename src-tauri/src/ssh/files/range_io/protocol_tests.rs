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
    closes: usize,
    disconnected: bool,
    open_gate: Option<Arc<tokio::sync::Semaphore>>,
    opens: usize,
}

#[derive(Clone, Default)]
struct CloseReply {
    gate: Option<Arc<tokio::sync::Semaphore>>,
    status: u32,
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
                    let gate = {
                        let mut state = state.lock().unwrap();
                        state.opens += 1;
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
                    reply.extend_from_slice(
                        &(if kind == 4 { close.status } else { 0 }).to_be_bytes(),
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
        state.lock().unwrap().disconnected = true;
    });
    (Arc::new(DataSession::new(client).await.unwrap()), observed)
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
