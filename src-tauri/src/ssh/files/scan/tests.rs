use super::*;
use russh_sftp::protocol::{Attrs, File, Handle, Name, Status};
use std::collections::HashMap;
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;

fn attrs(mode: u32, bytes: Option<u64>) -> FileAttributes {
    FileAttributes {
        permissions: Some(mode),
        size: bytes,
        ..FileAttributes::empty()
    }
}

#[derive(Default)]
struct Calls {
    stats: Vec<String>,
    directories: Vec<String>,
    closed: usize,
}

struct Node {
    attrs: FileAttributes,
    entries: Vec<(String, FileAttributes)>,
}

struct Server {
    nodes: HashMap<String, Node>,
    handles: HashMap<String, bool>,
    calls: Arc<Mutex<Calls>>,
}

impl russh_sftp::server::Handler for Server {
    type Error = StatusCode;

    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        self.calls.lock().unwrap().stats.push(path.clone());
        let node = self.nodes.get(&path).ok_or(StatusCode::PermissionDenied)?;
        Ok(Attrs {
            id,
            attrs: node.attrs.clone(),
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
        self.calls.lock().unwrap().directories.push(path.clone());
        self.nodes.get(&path).ok_or(StatusCode::NoSuchFile)?;
        self.handles.insert(path.clone(), false);
        Ok(Handle { id, handle: path })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, StatusCode> {
        let used = self.handles.get_mut(&handle).ok_or(StatusCode::Failure)?;
        if *used {
            return Err(StatusCode::Eof);
        }
        *used = true;
        Ok(Name {
            id,
            files: self.nodes[&handle]
                .entries
                .iter()
                .map(|(name, metadata)| File {
                    filename: name.clone(),
                    longname: String::new(),
                    attrs: metadata.clone(),
                })
                .collect(),
        })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, StatusCode> {
        self.handles.remove(&handle).ok_or(StatusCode::Failure)?;
        self.calls.lock().unwrap().closed += 1;
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        })
    }
}

async fn client(nodes: HashMap<String, Node>) -> (SftpSession, Arc<Mutex<Calls>>) {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let (client, server) = tokio::io::duplex(65536);
    russh_sftp::server::run(
        server,
        Server {
            nodes,
            handles: HashMap::new(),
            calls: calls.clone(),
        },
    )
    .await;
    (SftpSession::new(client).await.unwrap(), calls)
}

fn remote(path: &str) -> Endpoint {
    Endpoint {
        session: Some("test".into()),
        path: path.into(),
    }
}

fn directory(entries: Vec<(String, FileAttributes)>) -> Node {
    Node {
        attrs: attrs(0o040755, None),
        entries,
    }
}

#[tokio::test]
async fn uses_readdir_file_sizes_without_a_stat_round_trip_per_file() {
    let entries = (0..256)
        .map(|n| (format!("item-{n}"), attrs(0o100644, Some(n))))
        .chain([
            ("空目录".into(), attrs(0o040700, None)),
            ("nested".into(), attrs(0o040755, None)),
        ])
        .collect();
    let (sftp, calls) = client(HashMap::from([
        ("/root".into(), directory(entries)),
        ("/root/空目录".into(), directory(vec![])),
        (
            "/root/nested".into(),
            directory(vec![("zero".into(), attrs(0o100600, Some(0)))]),
        ),
    ]))
    .await;
    assert_eq!(
        measure(&remote("/root"), Some(&sftp), 4).await.unwrap(),
        32640
    );
    sftp.close().await.unwrap();
    let calls = calls.lock().unwrap();
    assert_eq!(calls.stats.len(), 3);
    assert_eq!(calls.directories.len(), 3);
    assert_eq!(calls.closed, 3);
    assert!(!calls.stats.iter().any(|name| name.contains("item-")));
}

#[tokio::test]
async fn incomplete_listing_metadata_falls_back_to_lstat_and_keeps_empty_files() {
    let entries = vec![
        (
            "missing-mode".into(),
            FileAttributes {
                size: Some(9),
                ..FileAttributes::empty()
            },
        ),
        ("missing-size".into(), attrs(0o100644, None)),
        ("permissions-only".into(), attrs(0o644, Some(100))),
    ];
    let mut nodes = HashMap::from([("/root".into(), directory(entries))]);
    for (name, bytes) in [
        ("missing-mode", 0),
        ("missing-size", 7),
        ("permissions-only", 3),
    ] {
        nodes.insert(
            format!("/root/{name}"),
            Node {
                attrs: attrs(0o100644, Some(bytes)),
                entries: vec![],
            },
        );
    }
    let (sftp, calls) = client(nodes).await;
    assert_eq!(measure(&remote("/root"), Some(&sftp), 4).await.unwrap(), 10);
    sftp.close().await.unwrap();
    assert_eq!(calls.lock().unwrap().stats.len(), 4);
}

#[tokio::test]
async fn rejects_links_special_files_and_undetermined_metadata_without_opening_file_data() {
    for (metadata, error) in [
        (attrs(0o120777, Some(9)), "sftp.symlinkUnsupported"),
        (attrs(0o010600, Some(0)), "sftp.fileTypeUnsupported"),
        (attrs(0o020600, Some(0)), "sftp.fileTypeUnsupported"),
        (attrs(0o060600, Some(0)), "sftp.fileTypeUnsupported"),
        (attrs(0o140600, Some(0)), "sftp.fileTypeUnsupported"),
        (attrs(0o100644, None), "sftp.fileMetadataMissing"),
        (FileAttributes::empty(), "sftp.fileMetadataMissing"),
    ] {
        let (sftp, _) = client(HashMap::from([(
            "/root".into(),
            Node {
                attrs: metadata,
                entries: vec![],
            },
        )]))
        .await;
        assert_eq!(
            measure(&remote("/root"), Some(&sftp), 4)
                .await
                .unwrap_err()
                .to_string(),
            error
        );
        sftp.close().await.unwrap();
    }
}

#[tokio::test]
async fn directory_hints_are_revalidated_before_traversal() {
    let (sftp, calls) = client(HashMap::from([
        (
            "/root".into(),
            directory(vec![("changed".into(), attrs(0o040755, None))]),
        ),
        (
            "/root/changed".into(),
            Node {
                attrs: attrs(0o120777, Some(7)),
                entries: vec![],
            },
        ),
    ]))
    .await;
    assert_eq!(
        measure(&remote("/root"), Some(&sftp), 4)
            .await
            .unwrap_err()
            .to_string(),
        "sftp.symlinkUnsupported"
    );
    sftp.close().await.unwrap();
    assert_eq!(calls.lock().unwrap().directories, ["/root"]);
}

#[tokio::test]
async fn malformed_duplicate_or_traversing_names_do_not_escape_the_source_tree() {
    for names in [
        vec!["../escape"],
        vec!["/escape"],
        vec![""],
        vec!["bad\0name"],
        vec!["same", "same"],
    ] {
        let (sftp, calls) = client(HashMap::from([(
            "/root".into(),
            directory(
                names
                    .into_iter()
                    .map(|n| (n.into(), attrs(0o100644, Some(1))))
                    .collect(),
            ),
        )]))
        .await;
        assert_eq!(
            measure(&remote("/root"), Some(&sftp), 4)
                .await
                .unwrap_err()
                .to_string(),
            "sftp.resumeSourceChanged"
        );
        sftp.close().await.unwrap();
        assert_eq!(calls.lock().unwrap().stats, ["/root"]);
    }
}

#[tokio::test]
async fn unreadable_child_and_length_overflow_fail_instead_of_reporting_zero() {
    for (entries, error) in [
        (vec![("denied".into(), FileAttributes::empty())], None),
        (
            vec![
                ("max".into(), attrs(0o100644, Some(u64::MAX))),
                ("one".into(), attrs(0o100644, Some(1))),
            ],
            Some("sftp.transferTooLarge"),
        ),
    ] {
        let (sftp, _) = client(HashMap::from([("/root".into(), directory(entries))])).await;
        let failure = measure(&remote("/root"), Some(&sftp), 4).await.unwrap_err();
        if let Some(message) = error {
            assert_eq!(failure.to_string(), message);
        }
        sftp.close().await.unwrap();
    }
    assert_eq!(
        walk(0, 4, |n| async move {
            Ok(Visit {
                bytes: if n == 0 { u64::MAX } else { 1 },
                children: if n == 0 { vec![1] } else { vec![] },
            })
        })
        .await
        .unwrap_err()
        .to_string(),
        "sftp.transferTooLarge"
    );
}

struct Active(Arc<AtomicUsize>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn whole_tree_concurrency_is_bounded_and_honors_a_single_request_budget() {
    for (budget, expected) in [(0, 1), (1, 1), (2, 2), (4, 4), (64, 4)] {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let total = walk(0, budget, |n| {
            let active = active.clone();
            let peak = peak.clone();
            async move {
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                let _guard = Active(active);
                peak.fetch_max(current, Ordering::SeqCst);
                tokio::task::yield_now().await;
                Ok(Visit {
                    bytes: 1,
                    children: if n < 10 {
                        vec![n * 3 + 1, n * 3 + 2, n * 3 + 3]
                    } else {
                        vec![]
                    },
                })
            }
        })
        .await
        .unwrap();
        assert_eq!(total, 31);
        assert_eq!(peak.load(Ordering::SeqCst), expected);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn very_deep_trees_do_not_recurse_on_the_stack() {
    assert_eq!(
        walk(0, 4, |n| async move {
            Ok(Visit {
                bytes: 1,
                children: if n < 20000 { vec![n + 1] } else { vec![] },
            })
        })
        .await
        .unwrap(),
        20001
    );
}

#[tokio::test]
async fn pause_drops_pending_readonly_work_without_starting_the_queued_remainder() {
    let started = Arc::new(AtomicUsize::new(0));
    let active = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    {
        let operation = walk(0, 4, |n| {
            let started = started.clone();
            let active = active.clone();
            let gate = gate.clone();
            async move {
                if n == 0 {
                    return Ok(Visit {
                        bytes: 0,
                        children: (1..100).collect(),
                    });
                }
                started.fetch_add(1, Ordering::SeqCst);
                active.fetch_add(1, Ordering::SeqCst);
                let _guard = Active(active);
                let _permit = gate.acquire().await.unwrap();
                Ok(Visit {
                    bytes: 1,
                    children: vec![],
                })
            }
        });
        tokio::pin!(operation);
        assert!(futures_util::poll!(&mut operation).is_pending());
        assert_eq!(started.load(Ordering::SeqCst), 4);
        assert_eq!(active.load(Ordering::SeqCst), 4);
    }
    assert_eq!(active.load(Ordering::SeqCst), 0);
    assert_eq!(started.load(Ordering::SeqCst), 4);
}

#[cfg(unix)]
#[tokio::test]
async fn local_socket_is_rejected_without_blocking_on_open() {
    // macOS temp roots can be long; keep the Unix-domain socket path short.
    let root = std::env::temp_dir().join(format!(
        "td-scan-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    ));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("socket");
    let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    let target = root.join("copy");
    assert_eq!(
        copy_local_entry(&path, &target, false)
            .unwrap_err()
            .to_string(),
        "sftp.fileTypeUnsupported"
    );
    assert!(!target.exists());
    let result = measure(
        &Endpoint {
            session: None,
            path: display_path(&root),
        },
        None,
        4,
    )
    .await;
    drop(listener);
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(root).unwrap();
    assert_eq!(result.unwrap_err().to_string(), "sftp.fileTypeUnsupported");
}
