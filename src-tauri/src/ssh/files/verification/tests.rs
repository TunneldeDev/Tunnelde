use super::*;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Barrier, Semaphore};

#[derive(Default)]
struct Observed {
    requests: Vec<u8>,
    pending: usize,
    peak: usize,
}

#[derive(Default)]
struct Replies {
    short_read: Option<usize>,
    delay: Duration,
    first_read: Option<Arc<Barrier>>,
    stalled: Option<(u8, Arc<Semaphore>)>,
    close_error: bool,
    read_error: bool,
}

fn field(packet: &mut Vec<u8>, data: &[u8]) {
    packet.extend_from_slice(&(data.len() as u32).to_be_bytes());
    packet.extend_from_slice(data);
}

fn status(packet: &mut Vec<u8>, code: u32) {
    packet.extend_from_slice(&code.to_be_bytes());
    field(
        packet,
        format!("verification fixture status {code}").as_bytes(),
    );
    field(packet, b"");
}

// Real SFTP framing and client read-ahead, with independent response scheduling.
// No SSH service or machine network settings are changed by these fixtures.
async fn session(data: Vec<u8>, replies: Replies) -> (SftpSession, Arc<Mutex<Observed>>) {
    let (client, server) = tokio::io::duplex(1024 * 1024);
    let observed = Arc::new(Mutex::new(Observed::default()));
    let calls = observed.clone();
    let (mut input, mut output) = tokio::io::split(server);
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel::<(Vec<u8>, bool)>();
    let written = observed.clone();
    tokio::spawn(async move {
        while let Some((packet, read)) = receive.recv().await {
            if output.write_u32(packet.len() as u32).await.is_err()
                || output.write_all(&packet).await.is_err()
            {
                break;
            }
            if read {
                written.lock().unwrap().pending -= 1;
            }
        }
    });
    tokio::spawn(async move {
        let mut first_read = replies.first_read;
        let mut stalled = replies.stalled;
        while let Ok(length) = input.read_u32().await {
            let mut request = vec![0; length as usize];
            if input.read_exact(&mut request).await.is_err() {
                break;
            }
            let kind = request[0];
            calls.lock().unwrap().requests.push(kind);
            let mut packet = Vec::new();
            if kind == 1 {
                packet.push(2);
                packet.extend_from_slice(&3_u32.to_be_bytes());
            } else {
                packet.push(match kind {
                    3 => 102,
                    5 if !replies.read_error => 103,
                    4 | 5 => 101,
                    _ => panic!("unexpected verification request {kind}"),
                });
                packet.extend_from_slice(&request[1..5]);
                match kind {
                    3 => field(&mut packet, b"file"),
                    4 => status(&mut packet, if replies.close_error { 4 } else { 0 }),
                    5 if replies.read_error => status(&mut packet, 3),
                    5 => {
                        let handle_length =
                            u32::from_be_bytes(request[5..9].try_into().unwrap()) as usize;
                        let pos = 9 + handle_length;
                        let offset =
                            u64::from_be_bytes(request[pos..pos + 8].try_into().unwrap()) as usize;
                        let requested =
                            u32::from_be_bytes(request[pos + 8..pos + 12].try_into().unwrap())
                                as usize;
                        if offset >= data.len() {
                            packet[0] = 101;
                            status(&mut packet, 1);
                        } else {
                            let count = requested.min(replies.short_read.unwrap_or(requested));
                            field(&mut packet, &data[offset..(offset + count).min(data.len())]);
                        }
                    }
                    _ => unreachable!(),
                }
            }
            let barrier = if kind == 5 { first_read.take() } else { None };
            let gate = if stalled
                .as_ref()
                .is_some_and(|(blocked, _)| *blocked == kind)
            {
                stalled.take().map(|(_, gate)| gate)
            } else {
                None
            };
            if kind == 5 {
                let mut observed = calls.lock().unwrap();
                observed.pending += 1;
                observed.peak = observed.peak.max(observed.pending);
            }
            let send = send.clone();
            let delay = replies.delay;
            tokio::spawn(async move {
                if let Some(barrier) = barrier {
                    barrier.wait().await;
                }
                if let Some(gate) = gate {
                    gate.acquire().await.unwrap().forget();
                }
                if kind == 5 && !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                let _ = send.send((packet, kind == 5));
            });
        }
    });
    let config = russh_sftp::client::Config {
        max_concurrent_reads: 8,
        max_packet_len: 32781,
        ..Default::default()
    };
    (
        SftpSession::new_with_config(client, config).await.unwrap(),
        observed,
    )
}

fn endpoint() -> Endpoint {
    Endpoint {
        session: Some("verification-fixture".into()),
        path: "/partial".into(),
    }
}

async fn wait_for(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while !condition() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("SFTP verification request did not arrive");
}

#[tokio::test]
async fn remote_verification_reads_both_sides_concurrently_with_bounded_prefetch() {
    let data: Vec<u8> = (0..CHUNK * 12 + 19).map(|n| (n % 251) as u8).collect();
    let barrier = Arc::new(Barrier::new(2));
    let (source, source_calls) = session(
        data.clone(),
        Replies {
            first_read: Some(barrier.clone()),
            ..Default::default()
        },
    )
    .await;
    let (target, target_calls) = session(
        data.clone(),
        Replies {
            first_read: Some(barrier),
            ..Default::default()
        },
    )
    .await;
    let mut reader = open_reader(&endpoint(), Some(&source)).await.unwrap();
    let existing = (data.len() - 10) as u64;
    tokio::time::timeout(
        Duration::from_secs(2),
        verify_prefix(&mut reader, &endpoint(), Some(&target), existing, None),
    )
    .await
    .expect("verification serialized the two initial READ requests")
    .unwrap();
    let mut next = [0; 10];
    read_block(&mut reader, &mut next).await.unwrap();
    assert_eq!(next, data[existing as usize..]);
    reader.finish().await.unwrap();
    for calls in [source_calls, target_calls] {
        let calls = calls.lock().unwrap();
        assert!(
            calls.peak > 1 && calls.peak <= 8,
            "unbounded or missing read-ahead: {}",
            calls.peak
        );
        assert_eq!(calls.requests.iter().filter(|&&kind| kind == 4).count(), 1);
    }
}

#[tokio::test]
async fn remote_verification_handles_short_reads_truncation_and_middle_corruption() {
    let data: Vec<u8> = (0..CHUNK * 3 + 19).map(|n| (n % 251) as u8).collect();
    for failure in [None, Some("middle"), Some("truncated")] {
        let mut partial = data.clone();
        match failure {
            Some("middle") => partial[CHUNK + 9] ^= 1,
            Some("truncated") => partial.truncate(CHUNK + 1),
            _ => {}
        }
        let (source, _) = session(data.clone(), Replies::default()).await;
        let (target, calls) = session(
            partial,
            Replies {
                short_read: Some(1009),
                ..Default::default()
            },
        )
        .await;
        let mut reader = open_reader(&endpoint(), Some(&source)).await.unwrap();
        let result = verify_prefix(
            &mut reader,
            &endpoint(),
            Some(&target),
            data.len() as u64,
            None,
        )
        .await;
        if failure.is_none() {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err().to_string(), "sftp.resumePrefixMismatch");
        }
        reader.finish().await.unwrap();
        assert_eq!(
            calls
                .lock()
                .unwrap()
                .requests
                .iter()
                .filter(|&&kind| kind == 4)
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn cancelled_remote_verification_does_not_wait_for_open_read_or_close_replies() {
    for blocked in [3, 5, 4] {
        let data = vec![7; CHUNK * 3];
        let (source, _) = session(data.clone(), Replies::default()).await;
        let gate = Arc::new(Semaphore::new(0));
        let (target, calls) = session(
            data.clone(),
            Replies {
                stalled: Some((blocked, gate.clone())),
                ..Default::default()
            },
        )
        .await;
        let mut reader = open_reader(&endpoint(), Some(&source)).await.unwrap();
        let cancel = AtomicBool::new(false);
        let partial = endpoint();
        let (result, ()) = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(
                verify_prefix(
                    &mut reader,
                    &partial,
                    Some(&target),
                    data.len() as u64,
                    Some(&cancel)
                ),
                async {
                    wait_for(|| calls.lock().unwrap().requests.contains(&blocked)).await;
                    cancel.store(true, Ordering::SeqCst);
                },
            )
        })
        .await
        .expect("cancellation waited for a withheld SFTP response");
        assert_eq!(result.unwrap_err().to_string(), CANCELLED);
        gate.add_permits(1);
        reader.finish().await.unwrap();
        // A cancelled read-only operation must leave the shared channel usable.
        let another = open_reader(&endpoint(), Some(&target)).await.unwrap();
        another.finish().await.unwrap();
    }
}

#[tokio::test]
async fn remote_verification_preserves_read_and_close_failures() {
    for read_error in [false, true] {
        let data = vec![7; CHUNK];
        let (source, _) = session(data.clone(), Replies::default()).await;
        let (target, _) = session(
            data,
            Replies {
                close_error: true,
                read_error,
                ..Default::default()
            },
        )
        .await;
        let mut reader = open_reader(&endpoint(), Some(&source)).await.unwrap();
        let error = verify_prefix(&mut reader, &endpoint(), Some(&target), CHUNK as u64, None)
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(if read_error { "status 3" } else { "status 4" }),
            "{error}"
        );
        reader.finish().await.unwrap();
    }
}

#[tokio::test]
#[ignore = "controlled-latency throughput comparison; run explicitly with --nocapture"]
async fn measure_remote_verification_concurrent_and_serial_reads() {
    let data = vec![17; 4 * 1024 * 1024 + 19];
    for serial in [true, false, true, false] {
        let options = || Replies {
            delay: Duration::from_millis(8),
            ..Default::default()
        };
        let (source, _) = session(data.clone(), options()).await;
        let (target, _) = session(data.clone(), options()).await;
        let mut reader = open_reader(&endpoint(), Some(&source)).await.unwrap();
        let started = Instant::now();
        if serial {
            let mut other = open_reader(&endpoint(), Some(&target)).await.unwrap();
            let mut left = data.len();
            let mut a = vec![0; CHUNK];
            let mut b = vec![0; CHUNK];
            while left > 0 {
                let n = left.min(CHUNK);
                read_block(&mut reader, &mut a[..n]).await.unwrap();
                read_block(&mut other, &mut b[..n]).await.unwrap();
                assert_eq!(a[..n], b[..n]);
                left -= n;
            }
            other.finish().await.unwrap();
        } else {
            verify_prefix(
                &mut reader,
                &endpoint(),
                Some(&target),
                data.len() as u64,
                None,
            )
            .await
            .unwrap();
        }
        println!(
            "verification serial={serial} elapsed_ms={} MiB_per_s={:.2}",
            started.elapsed().as_millis(),
            data.len() as f64 / 1048576.0 / started.elapsed().as_secs_f64()
        );
        reader.finish().await.unwrap();
    }
}
