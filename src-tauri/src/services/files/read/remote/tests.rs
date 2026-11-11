use super::*;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Default)]
struct Observed {
    packets: Vec<u8>,
    reads: Vec<(u64, usize)>,
    flags: Vec<u32>,
}

#[derive(Default)]
struct Replies {
    short: Option<usize>,
    oversize: bool,
    opened_directory: bool,
    missing_size: bool,
    gate: Option<(u8, Arc<Semaphore>)>,
    limits: Option<(u64, u64)>,
}

struct Fixture {
    stream: Option<tokio::io::DuplexStream>,
    observed: Arc<Mutex<Observed>>,
    changed: Arc<tokio::sync::Notify>,
    closed: tokio::sync::watch::Receiver<bool>,
}

fn string(packet: &mut Vec<u8>, bytes: &[u8]) {
    packet.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    packet.extend_from_slice(bytes);
}

fn attrs(packet: &mut Vec<u8>, size: Option<u64>, mode: u32) {
    packet.extend_from_slice(&(4_u32 | u32::from(size.is_some())).to_be_bytes());
    if let Some(size) = size {
        packet.extend_from_slice(&size.to_be_bytes());
    }
    packet.extend_from_slice(&mode.to_be_bytes());
}

fn status(packet: &mut Vec<u8>, code: u32) {
    packet[0] = 101;
    packet.extend_from_slice(&code.to_be_bytes());
    string(packet, b"isolated fixture");
    string(packet, b"");
}

impl Fixture {
    fn new(bytes: Vec<u8>, replies: Replies) -> Self {
        let (stream, server) = tokio::io::duplex(1024 * 1024);
        let observed = Arc::new(Mutex::new(Observed::default()));
        let changed = Arc::new(tokio::sync::Notify::new());
        let (closed, receiver) = tokio::sync::watch::channel(false);
        let calls = observed.clone();
        let notify = changed.clone();
        let (mut input, mut output) = tokio::io::split(server);
        let (send, mut receive) =
            tokio::sync::mpsc::channel::<(Vec<u8>, Option<Arc<Semaphore>>)>(32);
        // Independent replies let a cancelled read arrive after a later read.
        let (ready, mut incoming) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
        tokio::spawn(async move {
            while let Some((packet, gate)) = receive.recv().await {
                let ready = ready.clone();
                tokio::spawn(async move {
                    if let Some(gate) = gate {
                        gate.acquire().await.unwrap().forget();
                    }
                    let _ = ready.send(packet).await;
                });
            }
        });
        tokio::spawn(async move {
            while let Some(packet) = incoming.recv().await {
                if output.write_u32(packet.len() as u32).await.is_err()
                    || output.write_all(&packet).await.is_err()
                {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            let mut gate = replies.gate;
            while let Ok(length) = input.read_u32().await {
                assert!(length <= 512 * 1024);
                let mut request = vec![0; length as usize];
                if input.read_exact(&mut request).await.is_err() {
                    break;
                }
                let kind = request[0];
                let mut packet = vec![match kind {
                    1 => 2,
                    3 => 102,
                    8 | 17 => 105,
                    5 => 103,
                    4 => 101,
                    200 => 201,
                    _ => panic!("Unexpected read-only request {kind}"),
                }];
                packet.extend_from_slice(&request[1..5]);
                calls.lock().unwrap().packets.push(kind);
                match kind {
                    1 => {
                        if replies.limits.is_some() {
                            string(&mut packet, b"limits@openssh.com");
                            string(&mut packet, b"1");
                        }
                    }
                    200 => {
                        let (packet_size, read_size) = replies.limits.unwrap();
                        for size in [packet_size, read_size, 32768, 1] {
                            packet.extend_from_slice(&size.to_be_bytes());
                        }
                    }
                    3 => {
                        let n = u32::from_be_bytes(request[5..9].try_into().unwrap()) as usize;
                        calls.lock().unwrap().flags.push(u32::from_be_bytes(
                            request[9 + n..13 + n].try_into().unwrap(),
                        ));
                        string(&mut packet, b"opened-file");
                    }
                    8 | 17 => {
                        let size = if replies.missing_size && kind == 8 {
                            None
                        } else {
                            Some(bytes.len() as u64)
                        };
                        let mode = if replies.opened_directory && kind == 8 {
                            0o40700
                        } else {
                            0o100600
                        };
                        attrs(&mut packet, size, mode);
                    }
                    5 => {
                        let n = u32::from_be_bytes(request[5..9].try_into().unwrap()) as usize;
                        let pos = 9 + n;
                        let offset = u64::from_be_bytes(request[pos..pos + 8].try_into().unwrap());
                        let length =
                            u32::from_be_bytes(request[pos + 8..pos + 12].try_into().unwrap())
                                as usize;
                        calls.lock().unwrap().reads.push((offset, length));
                        if offset as usize >= bytes.len() {
                            status(&mut packet, 1);
                        } else {
                            let n = length.min(replies.short.unwrap_or(length));
                            let mut data = bytes
                                [offset as usize..(offset as usize + n).min(bytes.len())]
                                .to_vec();
                            if replies.oversize {
                                data.resize(length + 1, 0);
                            }
                            string(&mut packet, &data);
                        }
                    }
                    4 => status(&mut packet, 0),
                    _ => unreachable!(),
                }
                notify.notify_waiters();
                let blocked = if gate.as_ref().is_some_and(|(blocked, _)| *blocked == kind) {
                    gate.take().map(|(_, gate)| gate)
                } else {
                    None
                };
                if send.send((packet, blocked)).await.is_err() {
                    break;
                }
            }
            closed.send_replace(true);
        });
        Self {
            stream: Some(stream),
            observed,
            changed,
            closed: receiver,
        }
    }

    async fn open(&mut self) -> AppResult<(RemoteReader, u64)> {
        RemoteReader::from_stream(self.stream.take().unwrap(), "/source.bin".into()).await
    }

    async fn saw(&self, kind: u8) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let notified = self.changed.notified();
                if self.observed.lock().unwrap().packets.contains(&kind) {
                    return;
                }
                notified.await;
            }
        })
        .await
        .unwrap();
    }

    async fn closed(&mut self) {
        tokio::time::timeout(
            Duration::from_secs(3),
            self.closed.wait_for(|closed| *closed),
        )
        .await
        .unwrap()
        .unwrap();
    }
}

#[tokio::test]
async fn reads_explicit_ranges_without_prefetch_and_retries_short_packets() {
    let _serial = SERIAL.lock().await;
    let bytes: Vec<_> = (0..200_000).map(|n| (n % 251) as u8).collect();
    let mut fixture = Fixture::new(
        bytes.clone(),
        Replies {
            short: Some(7001),
            limits: Some((32781, 32768)),
            ..Default::default()
        },
    );
    let (reader, size) = fixture.open().await.unwrap();
    assert_eq!(size, bytes.len() as u64);
    let (a, b) = tokio::join!(reader.read(40_000, 80_000), reader.read(17, 23));
    assert_eq!(a.unwrap(), bytes[40_000..120_000]);
    assert_eq!(b.unwrap(), bytes[17..40]);
    {
        let calls = fixture.observed.lock().unwrap();
        assert_eq!(calls.flags, [1], "Only READ is granted to the SFTP handle");
        assert!(calls.reads.iter().all(|(_, length)| *length <= 32768));
        assert!(calls
            .reads
            .iter()
            .all(|(start, len)| (*start == 17 && *len == 23)
                || (*start >= 40_000 && *start + *len as u64 <= 120_000)));
    }
    reader.close().await;
    fixture.closed().await;
}

#[tokio::test]
async fn rejects_changed_type_missing_size_bad_limits_and_oversized_packets() {
    let _serial = SERIAL.lock().await;
    for (replies, expected) in [
        (
            Replies {
                opened_directory: true,
                ..Default::default()
            },
            "fileRead.invalidPath",
        ),
        (
            Replies {
                missing_size: true,
                ..Default::default()
            },
            "fileRead.metadataUnavailable",
        ),
        (
            Replies {
                limits: Some((13, 32)),
                ..Default::default()
            },
            "fileRead.invalidReply",
        ),
    ] {
        let mut fixture = Fixture::new(vec![1; 128], replies);
        let error = fixture.open().await.err().unwrap();
        assert_eq!(error.to_string(), expected);
        fixture.closed().await;
    }
    let mut fixture = Fixture::new(
        vec![1; 128],
        Replies {
            oversize: true,
            ..Default::default()
        },
    );
    let (reader, _) = fixture.open().await.unwrap();
    assert_eq!(
        reader.read(0, 10).await.unwrap_err().to_string(),
        "fileRead.invalidReply"
    );
    assert!(reader.read(0, 129).await.is_err());
    reader.close().await;
    fixture.closed().await;
}

#[tokio::test]
async fn cancelled_open_reclaims_a_handle_after_the_late_acknowledgement() {
    let _serial = SERIAL.lock().await;
    let gate = Arc::new(Semaphore::new(0));
    let mut fixture = Fixture::new(
        vec![1; 128],
        Replies {
            gate: Some((3, gate.clone())),
            ..Default::default()
        },
    );
    let stream = fixture.stream.take().unwrap();
    let task = tokio::spawn(RemoteReader::from_stream(stream, "/source.bin".into()));
    fixture.saw(3).await;
    task.abort();
    assert!(task.await.err().unwrap().is_cancelled());
    assert!(
        !*fixture.closed.borrow(),
        "Admission stays with the pending open worker"
    );
    gate.add_permits(1);
    fixture.closed().await;
    assert_eq!(fixture.observed.lock().unwrap().flags, [1]);
    assert!(!fixture.observed.lock().unwrap().packets.contains(&8));
}

#[tokio::test]
async fn late_cancelled_read_does_not_change_another_range_or_prefetch_the_remainder() {
    let _serial = SERIAL.lock().await;
    let gate = Arc::new(Semaphore::new(0));
    let bytes: Vec<_> = (0..100_000).map(|n| (n % 251) as u8).collect();
    let mut fixture = Fixture::new(
        bytes.clone(),
        Replies {
            gate: Some((5, gate.clone())),
            ..Default::default()
        },
    );
    let (reader, _) = fixture.open().await.unwrap();
    let old = reader.clone();
    let task = tokio::spawn(async move { old.read(0, 90_000).await });
    fixture.saw(5).await;
    task.abort();
    assert!(task.await.err().unwrap().is_cancelled());
    assert_eq!(
        reader.read(50_000, 50).await.unwrap(),
        bytes[50_000..50_050]
    );
    gate.add_permits(1);
    assert_eq!(reader.read(123, 31).await.unwrap(), bytes[123..154]);
    reader.close().await;
    fixture.closed().await;
    assert_eq!(
        fixture.observed.lock().unwrap().reads,
        [(0, 32768), (50_000, 50), (123, 31)]
    );
}

#[tokio::test]
async fn ranges_validate_before_requests_and_empty_files_need_no_read_packet() {
    let _serial = SERIAL.lock().await;
    let mut fixture = Fixture::new(vec![], Replies::default());
    let (reader, size) = fixture.open().await.unwrap();
    assert_eq!(size, 0);
    assert!(reader.read(0, 0).await.unwrap().is_empty());
    for (start, len) in [(u64::MAX, 1), (0, super::super::MAX_READ_BYTES + 1)] {
        assert_eq!(
            reader.read(start, len).await.unwrap_err().to_string(),
            "fileRead.invalidRange"
        );
    }
    reader.close().await;
    fixture.closed().await;
    assert!(fixture.observed.lock().unwrap().reads.is_empty());
}

#[tokio::test]
async fn truncated_ranges_report_source_change_and_retire_the_dedicated_channel() {
    let _serial = SERIAL.lock().await;
    let mut fixture = Fixture::new(vec![1; 20], Replies::default());
    let (reader, _) = fixture.open().await.unwrap();
    assert_eq!(
        reader.read(0, 21).await.unwrap_err().to_string(),
        "fileRead.sourceChanged"
    );
    fixture.closed().await;
    assert!(reader.read(0, 1).await.is_err());
}

#[tokio::test]
async fn a_read_deadline_closes_its_channel_before_work_capacity_is_released() {
    let _serial = SERIAL.lock().await;
    let gate = Arc::new(Semaphore::new(0));
    let mut fixture = Fixture::new(
        vec![1; 128],
        Replies {
            gate: Some((5, gate.clone())),
            ..Default::default()
        },
    );
    let (reader, _) = fixture.open().await.unwrap();
    assert_eq!(
        reader
            .read_with_deadline(0, 16, Duration::from_millis(20))
            .await
            .unwrap_err()
            .to_string(),
        "sftp.transferTimedOut"
    );
    fixture.closed().await;
    assert!(reader.read(0, 1).await.is_err());
    gate.add_permits(1);
}
