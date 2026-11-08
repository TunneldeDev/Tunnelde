use super::*;
use russh_sftp::protocol::*;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
struct Tree {
    directories: std::collections::HashSet<String>,
    files: HashMap<String, Vec<u8>>,
    modes: HashMap<String, u32>,
    lstats: usize,
}

struct Gate {
    before_create: bool,
    arrived: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
    finished: tokio::sync::Semaphore,
}

struct Server {
    tree: Arc<Mutex<Tree>>,
    gate: Option<Arc<Gate>>,
    mkdir_gate: Option<Arc<Gate>>,
    listed: std::collections::HashSet<String>,
}

fn status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}

impl russh_sftp::server::Handler for Server {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn init(&mut self, _: u32, _: HashMap<String, String>) -> Result<Version, StatusCode> {
        Ok(Version::new())
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        let mut tree = self.tree.lock().unwrap();
        tree.lstats += 1;
        let mut attrs = FileAttributes::empty();
        if tree.directories.contains(&path) {
            attrs.permissions = Some(tree.modes.get(&path).copied().unwrap_or(0o40700));
        } else if let Some(data) = tree.files.get(&path) {
            attrs.permissions = Some(tree.modes.get(&path).copied().unwrap_or(0o100600));
            attrs.size = Some(data.len() as u64);
        } else {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(Attrs { id, attrs })
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        if let Some(gate) = self.gate.as_ref().filter(|g| g.before_create) {
            gate.arrived.add_permits(1);
            gate.release.acquire().await.unwrap().forget();
        }
        let created = {
            let mut tree = self.tree.lock().unwrap();
            let parent = path.rsplit_once('/').unwrap().0;
            if !tree.directories.contains(parent) {
                Err(StatusCode::NoSuchFile)
            } else if flags.contains(OpenFlags::EXCLUDE) && tree.files.contains_key(&path) {
                Err(StatusCode::Failure)
            } else {
                tree.files.entry(path).or_default();
                Ok(())
            }
        };
        if let Some(gate) = self.gate.as_ref().filter(|g| !g.before_create) {
            gate.arrived.add_permits(1);
            gate.release.acquire().await.unwrap().forget();
        }
        if let Some(gate) = &self.gate {
            gate.finished.add_permits(1);
        }
        created?;
        Ok(Handle {
            id,
            handle: "empty-writer".into(),
        })
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, StatusCode> {
        {
            let mut tree = self.tree.lock().unwrap();
            if tree.directories.contains(&path) || tree.files.contains_key(&path) {
                return Err(StatusCode::Failure);
            }
            tree.modes
                .insert(path.clone(), 0o40000 | attrs.permissions.unwrap_or(0o755));
            tree.directories.insert(path);
        }
        if let Some(gate) = &self.mkdir_gate {
            gate.arrived.add_permits(1);
            gate.release.acquire().await.unwrap().forget();
            gate.finished.add_permits(1);
        }
        Ok(status(id))
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
        if !self.tree.lock().unwrap().directories.contains(&path) {
            return Err(StatusCode::NoSuchFile);
        }
        self.listed.remove(&path);
        Ok(Handle { id, handle: path })
    }
    async fn readdir(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        if !self.listed.insert(path.clone()) {
            return Err(StatusCode::Eof);
        }
        let tree = self.tree.lock().unwrap();
        let prefix = path + "/";
        let files: Vec<_> = tree
            .files
            .keys()
            .chain(tree.directories.iter())
            .filter_map(|path| path.strip_prefix(&prefix))
            .filter(|name| !name.contains('/'))
            .map(|name| File {
                filename: name.into(),
                longname: name.into(),
                attrs: FileAttributes::empty(),
            })
            .collect();
        if files.is_empty() {
            return Err(StatusCode::Eof);
        }
        Ok(Name { id, files })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, StatusCode> {
        Ok(status(id))
    }
    async fn remove(&mut self, id: u32, path: String) -> Result<Status, StatusCode> {
        self.tree
            .lock()
            .unwrap()
            .files
            .remove(&path)
            .ok_or(StatusCode::NoSuchFile)?;
        Ok(status(id))
    }
    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, StatusCode> {
        let mut tree = self.tree.lock().unwrap();
        let prefix = path.clone() + "/";
        if tree.files.keys().any(|p| p.starts_with(&prefix))
            || tree.directories.iter().any(|p| p.starts_with(&prefix))
        {
            return Err(StatusCode::Failure);
        }
        if !tree.directories.remove(&path) {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(status(id))
    }
}

async fn client(tree: Arc<Mutex<Tree>>, gate: Option<Arc<Gate>>) -> SftpSession {
    let (client, server) = tokio::io::duplex(65536);
    russh_sftp::server::run(
        server,
        Server {
            tree,
            gate,
            mkdir_gate: None,
            listed: Default::default(),
        },
    )
    .await;
    SftpSession::new(client).await.unwrap()
}

async fn directory_client(
    tree: Arc<Mutex<Tree>>,
    mkdir_gate: Option<Arc<Gate>>,
) -> range_io::DataSession {
    let (client, server) = tokio::io::duplex(65536);
    russh_sftp::server::run(
        server,
        Server {
            tree,
            gate: None,
            mkdir_gate,
            listed: Default::default(),
        },
    )
    .await;
    range_io::DataSession::new(client).await.unwrap()
}

#[tokio::test]
async fn private_directory_creation_sets_permissions_without_a_chmod_window() {
    let tree = Arc::new(Mutex::new(Tree::default()));
    let observer = client(tree.clone(), None).await;
    let data = directory_client(tree.clone(), None).await;
    let data_ref = &data;
    let directory = Endpoint {
        session: Some("remote".into()),
        path: "/private-stage".into(),
    };
    ensure_private_directory(
        &observer,
        &directory,
        &AtomicBool::new(false),
        |path| async move { data_ref.create_private_directory(&path.path).await },
    )
    .await
    .unwrap();
    // This protocol server does not implement SETSTAT: creation must supply the
    // final permissions itself and succeed without any permission-widening step.
    assert_eq!(tree.lock().unwrap().modes[&directory.path], 0o40700);
    observer.close().await.unwrap();
}

#[tokio::test]
async fn exclusive_staging_create_never_overwrites_an_existing_object() {
    let tree = Arc::new(Mutex::new(Tree::default()));
    tree.lock()
        .unwrap()
        .directories
        .insert("/private-stage".into());
    let path = "/private-stage/foreign.part";
    tree.lock()
        .unwrap()
        .files
        .insert(path.into(), b"preserve".to_vec());
    let observer = client(tree.clone(), None).await;
    let part = Endpoint {
        session: Some("remote".into()),
        path: path.into(),
    };
    // No LSTAT is necessary to make exclusive OPEN safe: an existing entry must
    // make OPEN fail, without permitting truncation or a subsequent data writer.
    assert!(create_writer(&part, Some(&observer), false).await.is_err());
    assert_eq!(tree.lock().unwrap().files[path], b"preserve");
    observer.close().await.unwrap();
}

#[tokio::test]
async fn length_probe_classifies_the_same_metadata_without_duplicate_round_trips() {
    let tree = Arc::new(Mutex::new(Tree::default()));
    {
        let mut state = tree.lock().unwrap();
        state.files.insert("/file".into(), b"data".to_vec());
        state.files.insert("/link".into(), Vec::new());
        state.modes.insert("/link".into(), 0o120777);
        state.directories.insert("/directory".into());
    }
    let observer = client(tree.clone(), None).await;
    let endpoint = |path: &str| Endpoint {
        session: Some("remote".into()),
        path: path.into(),
    };
    assert_eq!(
        file_length(&endpoint("/file"), Some(&observer))
            .await
            .unwrap(),
        Some(4)
    );
    assert_eq!(
        file_length(&endpoint("/missing"), Some(&observer))
            .await
            .unwrap(),
        None
    );
    assert!(
        matches!(file_length(&endpoint("/link"), Some(&observer)).await,
        Err(AppError::Validation(error)) if error == "sftp.symlinkUnsupported")
    );
    assert!(
        matches!(file_length(&endpoint("/directory"), Some(&observer)).await,
        Err(AppError::Validation(error)) if error == "sftp.typeConflict")
    );
    assert_eq!(tree.lock().unwrap().lstats, 4);
    observer.close().await.unwrap();
}

#[tokio::test]
async fn restart_after_lost_mkdir_reply_adopts_only_the_empty_private_directory() {
    let to = Endpoint {
        session: Some("remote".into()),
        path: "/target".into(),
    };
    let mut saved = record(&to);
    if let ArtifactRecord::Current {
        staging: Some(staging),
        ..
    } = &mut saved
    {
        staging.prepared = false;
        staging.opening = false;
    }
    let restored: ArtifactRecord =
        serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
    let directory =
        staging_directory(&to, "job", remote_staging(Some(&restored)).unwrap()).unwrap();
    let tree = Arc::new(Mutex::new(Tree::default()));
    let observer = client(tree.clone(), None).await;
    let gate = Arc::new(Gate {
        before_create: false,
        arrived: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
        finished: tokio::sync::Semaphore::new(0),
    });
    let data = directory_client(tree.clone(), Some(gate.clone())).await;
    let data_ref = &data;
    let cancel = AtomicBool::new(false);
    tokio::select! {
        result = ensure_private_directory(&observer, &directory, &cancel, |path| async move {
            data_ref.create_private_directory(&path.path).await
        }) => panic!("MKDIR acknowledgement should be withheld: {result:?}"),
        permit = gate.arrived.acquire() => permit.unwrap().forget(),
    }
    drop(data); // Simulate termination before the private-directory checkpoint.
    assert_eq!(tree.lock().unwrap().modes[&directory.path], 0o40700);
    ensure_private_directory(&observer, &directory, &AtomicBool::new(false), |_| async {
        panic!("Recovery must validate the existing directory, never create or chmod it")
    })
    .await
    .unwrap();
    // A late reply cannot alter content subsequently written by the resumed task.
    let part = part_from_record(&to, "job", Some(&restored)).unwrap();
    tree.lock()
        .unwrap()
        .files
        .insert(part.path.clone(), b"resumed contents".to_vec());
    gate.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(1), gate.finished.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert_eq!(tree.lock().unwrap().files[&part.path], b"resumed contents");
    observer.close().await.unwrap();
}

#[tokio::test]
async fn directory_recovery_preserves_foreign_types_permissions_and_contents() {
    for (is_directory, mode, contents) in [
        (false, 0o100600, 0),
        (true, 0o120700, 0),
        (true, 0o40755, 0),
        (true, 0o40700, 1),
        (true, 0o40700, 2),
    ] {
        let tree = Arc::new(Mutex::new(Tree::default()));
        let directory = Endpoint {
            session: Some("remote".into()),
            path: "/private-stage".into(),
        };
        {
            let mut state = tree.lock().unwrap();
            if is_directory {
                state.directories.insert(directory.path.clone());
                state.modes.insert(directory.path.clone(), mode);
            } else {
                state
                    .files
                    .insert(directory.path.clone(), b"foreign".to_vec());
            }
            if contents == 1 {
                state
                    .files
                    .insert(directory.path.clone() + "/foreign", b"preserve".to_vec());
            } else if contents == 2 {
                state
                    .directories
                    .insert(directory.path.clone() + "/foreign");
            }
        }
        let observer = client(tree.clone(), None).await;
        let before = {
            let state = tree.lock().unwrap();
            (
                state.directories.clone(),
                state.files.clone(),
                state.modes.clone(),
            )
        };
        assert!(matches!(
            ensure_private_directory(&observer, &directory, &AtomicBool::new(false), |_| async {
                panic!("Existing foreign paths must never be modified")
            })
            .await,
            Err(AppError::TransferArtifactUnrecognized { .. })
        ));
        {
            let state = tree.lock().unwrap();
            assert_eq!(
                before,
                (
                    state.directories.clone(),
                    state.files.clone(),
                    state.modes.clone()
                )
            );
        }
        observer.close().await.unwrap();
    }
}

fn record(to: &Endpoint) -> ArtifactRecord {
    ArtifactRecord::Current {
        path: to.path.clone(),
        identity: None,
        archive: None,
        publication: None,
        staging: Some(RemoteStaging {
            generation: uuid::Uuid::new_v4().to_string(),
            prepared: true,
            opening: true,
        }),
    }
}

async fn cancelled_create(before_create: bool) {
    let to = Endpoint {
        session: Some("remote".into()),
        path: "/target".into(),
    };
    let saved = record(&to);
    // A restart must retain the uncertain opening and the exact parent generation.
    let restored: ArtifactRecord =
        serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
    let directory =
        staging_directory(&to, "job", remote_staging(Some(&restored)).unwrap()).unwrap();
    let part = part_from_record(&to, "job", Some(&restored)).unwrap();
    let tree = Arc::new(Mutex::new(Tree::default()));
    tree.lock()
        .unwrap()
        .directories
        .insert(directory.path.clone());
    let gate = Arc::new(Gate {
        before_create,
        arrived: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
        finished: tokio::sync::Semaphore::new(0),
    });
    let writer = client(tree.clone(), Some(gate.clone())).await;
    let observer = client(tree.clone(), None).await;
    let cancel = AtomicBool::new(false);
    let result = tokio::join!(
        interruptible(Some(&cancel), create_writer(&part, Some(&writer), false)),
        async {
            gate.arrived.acquire().await.unwrap().forget();
            cancel.store(true, Ordering::SeqCst);
        }
    )
    .0;
    assert!(matches!(result, Err(AppError::Ssh(error)) if error == CANCELLED));
    tokio::time::timeout(
        Duration::from_secs(1),
        retire_remote_staging("job", &to, &observer, &restored, &AtomicBool::new(false)),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!tree.lock().unwrap().directories.contains(&directory.path));
    // Resume uses another private directory, and its complete contents survive
    // execution/reply of the old CREATE on the still-live original connection.
    let new_record = record(&to);
    let new_part = part_from_record(&to, "job", Some(&new_record)).unwrap();
    let new_directory =
        staging_directory(&to, "job", remote_staging(Some(&new_record)).unwrap()).unwrap();
    tree.lock().unwrap().directories.insert(new_directory.path);
    tree.lock()
        .unwrap()
        .files
        .insert(new_part.path.clone(), b"resumed contents".to_vec());
    gate.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(1), gate.finished.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert!(!tree.lock().unwrap().files.contains_key(&part.path));
    assert_eq!(
        tree.lock().unwrap().files.get(&new_part.path).unwrap(),
        b"resumed contents"
    );
    // Repeated cleanup after a lost RMDIR acknowledgement is idempotent.
    retire_remote_staging("job", &to, &observer, &restored, &AtomicBool::new(false))
        .await
        .unwrap();
    writer.close().await.unwrap();
    observer.close().await.unwrap();
}

#[tokio::test]
async fn delayed_create_cannot_recreate_a_retired_parent_after_resume() {
    cancelled_create(true).await
}

#[tokio::test]
async fn lost_create_reply_does_not_reuse_or_leak_the_old_staging_file() {
    cancelled_create(false).await
}

#[tokio::test]
async fn uncertain_creation_cleanup_preserves_nonempty_or_foreign_files() {
    let to = Endpoint {
        session: Some("remote".into()),
        path: "/target".into(),
    };
    let saved = record(&to);
    let directory = staging_directory(&to, "job", remote_staging(Some(&saved)).unwrap()).unwrap();
    let part = part_from_record(&to, "job", Some(&saved)).unwrap();
    let tree = Arc::new(Mutex::new(Tree::default()));
    tree.lock()
        .unwrap()
        .directories
        .insert(directory.path.clone());
    tree.lock()
        .unwrap()
        .files
        .insert(part.path.clone(), b"unexpected data".to_vec());
    let observer = client(tree.clone(), None).await;
    assert!(matches!(
        retire_remote_staging("job", &to, &observer, &saved, &AtomicBool::new(false)).await,
        Err(AppError::TransferArtifactUnrecognized { .. })
    ));
    assert_eq!(
        tree.lock().unwrap().files.get(&part.path).unwrap(),
        b"unexpected data"
    );
    tree.lock().unwrap().files.remove(&part.path);
    let foreign = directory.path.clone() + "/unrelated";
    tree.lock()
        .unwrap()
        .files
        .insert(foreign.clone(), b"preserve".to_vec());
    assert!(
        retire_remote_staging("job", &to, &observer, &saved, &AtomicBool::new(false))
            .await
            .is_err()
    );
    assert_eq!(
        tree.lock().unwrap().files.get(&foreign).unwrap(),
        b"preserve"
    );
    assert!(tree.lock().unwrap().directories.contains(&directory.path));
    observer.close().await.unwrap();
}

#[test]
fn staging_generations_preserve_archive_and_publication_paths() {
    let to = Endpoint {
        session: Some("remote".into()),
        path: "/home/文件.txt".into(),
    };
    let mut saved = record(&to);
    let first = part_from_record(&to, "job", Some(&saved)).unwrap();
    let generation = uuid::Uuid::new_v4().to_string();
    let next = publication_successor(&to, "job", &generation, Some(&saved)).unwrap();
    assert_ne!(first.path, next.path);
    assert_eq!(
        first.path.rsplit_once('/').unwrap().0,
        next.path.rsplit_once('/').unwrap().0
    );
    if let ArtifactRecord::Current { archive, .. } = &mut saved {
        *archive = Some(ArchiveWrite {
            generation: Some(generation),
            pending: true,
        });
    }
    assert_eq!(
        part_from_record(&to, "job", Some(&saved)).unwrap().path,
        next.path
    );
    if let ArtifactRecord::Current {
        staging: Some(staging),
        ..
    } = &mut saved
    {
        staging.generation = "../invalid".into();
    }
    assert!(part_from_record(&to, "job", Some(&saved)).is_err());
}
