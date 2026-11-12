use super::*;
use russh_sftp::protocol::*;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::atomic::AtomicUsize;

mod authorization;
mod workers;

// Existing protocol cases exercise an uncancelled transaction; worker lifetime
// cases below use the real Budget and caller-owned cancellation state.
async fn staged_save(
    sftp: &SftpSession,
    replacement: &remote_commit::Replacement,
    requested: &str,
    target: &str,
    content: &str,
    baseline: &str,
    record: &Record,
) -> AppResult<()> {
    let (job, _caller) =
        crate::services::files::operations::Cancellation::for_test("editor.saveCancelled");
    transaction::staged_save(
        sftp,
        replacement,
        transaction::Draft {
            requested,
            target,
            content,
            baseline,
        },
        record,
        &job,
        &policy::Native,
    )
    .await
}

#[derive(Default)]
struct Probe {
    failure: Mutex<String>,
    mutate: AtomicBool,
    commits: AtomicUsize,
    closes: AtomicUsize,
    hold_close: AtomicBool,
    close_started: tokio::sync::Notify,
    release_close: tokio::sync::Notify,
    realpaths: AtomicUsize,
    mkdirs: AtomicUsize,
    hold_commit: AtomicBool,
    commit_started: tokio::sync::Notify,
    release_commit: tokio::sync::Notify,
    hold_rmdir: AtomicBool,
    rmdir_started: tokio::sync::Notify,
    release_rmdir: tokio::sync::Notify,
}

struct Server {
    root: PathBuf,
    probe: Arc<Probe>,
    files: HashMap<String, (String, std::fs::File)>,
    directories: HashMap<String, Option<Vec<File>>>,
    modes: Arc<Mutex<HashMap<String, u32>>>,
    next: u64,
}

fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}
fn io(error: std::io::Error) -> StatusCode {
    if error.kind() == std::io::ErrorKind::NotFound {
        StatusCode::NoSuchFile
    } else {
        StatusCode::Failure
    }
}

impl Server {
    fn path(&self, path: &str) -> PathBuf {
        self.root.join(path.trim_start_matches('/'))
    }
    fn attrs(&self, path: &str) -> Result<FileAttributes, StatusCode> {
        let metadata = std::fs::symlink_metadata(self.path(path)).map_err(io)?;
        let mut attrs = FileAttributes::from(&metadata);
        let modes = self.modes.lock().unwrap();
        let mode =
            modes
                .get(path)
                .copied()
                .unwrap_or(if metadata.is_dir() { 0o700 } else { 0o644 });
        attrs.permissions = Some(
            mode | if metadata.is_dir() {
                0o040000
            } else {
                0o100000
            },
        );
        // Virtual POSIX metadata on every platform; tests still use real OS I/O.
        attrs.uid = Some(1000);
        attrs.gid = Some(1000);
        Ok(attrs)
    }
    fn fails(&self, name: &str) -> bool {
        *self.probe.failure.lock().unwrap() == name
    }
}

impl russh_sftp::server::Handler for Server {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn init(&mut self, _: u32, _: HashMap<String, String>) -> Result<Version, StatusCode> {
        let mut version = Version::new();
        if !self.fails("unsupported") {
            version
                .extensions
                .insert("posix-rename@openssh.com".into(), "1".into());
        }
        version
            .extensions
            .insert("fsync@openssh.com".into(), "1".into());
        Ok(version)
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        self.probe.realpaths.fetch_add(1, Ordering::SeqCst);
        let full = std::fs::canonicalize(self.path(&path)).map_err(io)?;
        let root = std::fs::canonicalize(&self.root).map_err(io)?;
        let relative = full.strip_prefix(root).map_err(|_| StatusCode::Failure)?;
        let path = format!("/{}", relative.to_string_lossy().replace('\\', "/"));
        Ok(Name {
            id,
            files: vec![File::new(path, FileAttributes::empty())],
        })
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        Ok(Attrs {
            id,
            attrs: self.attrs(&path)?,
        })
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        self.stat(id, path).await
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        attrs: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        if self.fails("permission") && path == "/note.txt" && flags.contains(OpenFlags::WRITE) {
            return Err(StatusCode::PermissionDenied);
        }
        let file = std::fs::OpenOptions::new()
            .read(flags.contains(OpenFlags::READ))
            .write(flags.contains(OpenFlags::WRITE))
            .create(flags.contains(OpenFlags::CREATE))
            .create_new(flags.contains(OpenFlags::EXCLUDE))
            .truncate(flags.contains(OpenFlags::TRUNCATE))
            .open(self.path(&path))
            .map_err(io)?;
        if flags.contains(OpenFlags::CREATE) {
            self.modes
                .lock()
                .unwrap()
                .insert(path.clone(), attrs.permissions.unwrap_or(0o600));
        }
        let handle = self.next.to_string();
        self.next += 1;
        self.files.insert(handle.clone(), (path, file));
        Ok(Handle { id, handle })
    }
    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, StatusCode> {
        let (path, _) = self.files.get(&handle).ok_or(StatusCode::Failure)?;
        Ok(Attrs {
            id,
            attrs: self.attrs(path)?,
        })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, StatusCode> {
        let fail = self.fails("write");
        let (path, file) = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(io)?;
        if fail && path.ends_with("/content") {
            file.write_all(&data[..data.len() / 2]).map_err(io)?;
            return Err(StatusCode::Failure);
        }
        file.write_all(&data).map_err(io)?;
        Ok(ok(id))
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, StatusCode> {
        let (_, file) = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(io)?;
        let mut bytes = vec![0; (len as usize).min(7001)];
        let length = file.read(&mut bytes).map_err(io)?;
        if length == 0 {
            return Err(StatusCode::Eof);
        }
        bytes.truncate(length);
        Ok(Data { id, data: bytes })
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<Status, StatusCode> {
        if self.directories.remove(&handle).is_some() {
            return Ok(ok(id));
        }
        let (path, _) = self.files.remove(&handle).ok_or(StatusCode::Failure)?;
        self.probe.closes.fetch_add(1, Ordering::SeqCst);
        if path.ends_with("/content") {
            if self.probe.hold_close.swap(false, Ordering::SeqCst) {
                self.probe.close_started.notify_one();
                self.probe.release_close.notified().await;
            }
            if self.probe.mutate.swap(false, Ordering::SeqCst) {
                std::fs::write(self.path("/note.txt"), "external change").map_err(io)?;
            }
            if self.fails("close") {
                return Err(StatusCode::Failure);
            }
        }
        Ok(ok(id))
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, StatusCode> {
        std::fs::create_dir(self.path(&path)).map_err(io)?;
        self.probe.mkdirs.fetch_add(1, Ordering::SeqCst);
        self.modes
            .lock()
            .unwrap()
            .insert(path, attrs.permissions.unwrap_or(0o777));
        Ok(ok(id))
    }
    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, StatusCode> {
        if self.probe.hold_rmdir.swap(false, Ordering::SeqCst) {
            self.probe.rmdir_started.notify_one();
            self.probe.release_rmdir.notified().await;
        }
        if self.fails("rmdir") {
            return Err(StatusCode::Failure);
        }
        std::fs::remove_dir(self.path(&path)).map_err(io)?;
        Ok(ok(id))
    }
    async fn remove(&mut self, id: u32, path: String) -> Result<Status, StatusCode> {
        if self.fails("remove") {
            return Err(StatusCode::Failure);
        }
        std::fs::remove_file(self.path(&path)).map_err(io)?;
        Ok(ok(id))
    }
    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, StatusCode> {
        if self.fails("metadata") {
            return Err(StatusCode::PermissionDenied);
        }
        if let Some(mode) = attrs.permissions {
            self.modes.lock().unwrap().insert(path, mode);
        }
        Ok(ok(id))
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(self.path(&path)).map_err(io)? {
            let entry = entry.map_err(io)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            entries.push(File::new(
                name.clone(),
                self.attrs(&format!("{path}/{name}"))?,
            ));
        }
        let handle = format!("dir-{}", self.next);
        self.next += 1;
        self.directories.insert(handle.clone(), Some(entries));
        Ok(Handle { id, handle })
    }
    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, StatusCode> {
        let entries = self
            .directories
            .get_mut(&handle)
            .ok_or(StatusCode::Failure)?
            .take()
            .ok_or(StatusCode::Eof)?;
        Ok(Name { id, files: entries })
    }
    async fn extended(
        &mut self,
        id: u32,
        request: String,
        data: Vec<u8>,
    ) -> Result<Packet, StatusCode> {
        if request == "fsync@openssh.com" {
            if self.fails("fsync") {
                return Err(StatusCode::Failure);
            }
            return Ok(Packet::Status(ok(id)));
        }
        if request != "posix-rename@openssh.com" {
            return Err(StatusCode::OpUnsupported);
        }
        if self.fails("rename") {
            return Err(StatusCode::Failure);
        }
        let mut data = data.as_slice();
        let mut names = Vec::new();
        for _ in 0..2 {
            let mut length = [0; 4];
            std::io::Read::read_exact(&mut data, &mut length).map_err(io)?;
            let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
            std::io::Read::read_exact(&mut data, &mut bytes).map_err(io)?;
            names.push(String::from_utf8(bytes).map_err(|_| StatusCode::Failure)?);
        }
        self.probe.commits.fetch_add(1, Ordering::SeqCst);
        std::fs::rename(self.path(&names[0]), self.path(&names[1])).map_err(io)?;
        {
            let mut modes = self.modes.lock().unwrap();
            if let Some(mode) = modes.get(&names[0]).copied() {
                modes.insert(names[1].clone(), mode);
            }
        }
        if self.probe.hold_commit.swap(false, Ordering::SeqCst) {
            self.probe.commit_started.notify_one();
            self.probe.release_commit.notified().await;
        }
        if self.fails("lost-ack") {
            return Err(StatusCode::Failure);
        }
        Ok(Packet::Status(ok(id)))
    }
}

struct Fixture {
    root: PathBuf,
    probe: Arc<Probe>,
    modes: Arc<Mutex<HashMap<String, u32>>>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("tunnelde-editor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("note.txt"), "original").unwrap();
        Self {
            root,
            probe: Arc::new(Probe::default()),
            modes: Default::default(),
        }
    }
    async fn stream(&self) -> tokio::io::DuplexStream {
        let (client, server) = tokio::io::duplex(1024 * 1024);
        russh_sftp::server::run(
            server,
            Server {
                root: self.root.clone(),
                probe: self.probe.clone(),
                files: HashMap::new(),
                directories: HashMap::new(),
                modes: self.modes.clone(),
                next: 0,
            },
        )
        .await;
        client
    }
    async fn client(&self) -> SftpSession {
        SftpSession::new(self.stream().await).await.unwrap()
    }
    async fn replacement(&self) -> AppResult<remote_commit::Replacement> {
        remote_commit::Replacement::negotiate(russh_sftp::client::RawSftpSession::new(
            self.stream().await,
        ))
        .await
    }
    fn record(&self) -> Record {
        Record {
            id: "test".into(),
            host_id: "host".into(),
            address: "test".into(),
            path: "/note.txt".into(),
            directory: "/.tunnelde-save-test".into(),
            token: uuid::Uuid::new_v4().to_string(),
            removing_marker: false,
            updated_at: 0,
            error: None,
        }
    }
    fn disk(&self) -> String {
        std::fs::read_to_string(self.root.join("note.txt")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

#[tokio::test]
async fn atomically_saves_short_empty_unicode_bom_and_crlf() {
    let f = Fixture::new();
    let sftp = f.client().await;
    let mut baseline = "original".to_string();
    for text in [
        "短\r\n",
        "",
        "\u{feff}hello\r\nworld\n",
        &"界".repeat(40000),
    ] {
        let mut record = f.record();
        staged_save(
            &sftp,
            &f.replacement().await.unwrap(),
            "/note.txt",
            "/note.txt",
            text,
            &baseline,
            &record,
        )
        .await
        .unwrap();
        assert_eq!(f.disk(), text);
        cleanup(&sftp, &mut record, |_| Ok(())).await.unwrap();
        assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 1);
        baseline = text.to_string();
    }
    assert_eq!(f.probe.commits.load(Ordering::SeqCst), 4);
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn original_survives_partial_write_fsync_close_metadata_permission_and_rename_failures() {
    for failure in [
        "write",
        "fsync",
        "close",
        "metadata",
        "permission",
        "rename",
    ] {
        let f = Fixture::new();
        let sftp = f.client().await;
        *f.probe.failure.lock().unwrap() = failure.into();
        let mut record = f.record();
        assert!(
            staged_save(
                &sftp,
                &f.replacement().await.unwrap(),
                "/note.txt",
                "/note.txt",
                "replacement",
                "original",
                &record
            )
            .await
            .is_err(),
            "{failure}"
        );
        assert_eq!(f.disk(), "original", "{failure}");
        assert_eq!(f.probe.commits.load(Ordering::SeqCst), 0);
        *f.probe.failure.lock().unwrap() = String::new();
        cleanup(&sftp, &mut record, |_| Ok(())).await.unwrap();
        assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 1);
        sftp.close().await.unwrap();
    }
}

#[tokio::test]
async fn save_waits_for_close_and_rejects_changes_during_staging() {
    let f = Fixture::new();
    let sftp = f.client().await;
    let replacement = f.replacement().await.unwrap();
    f.probe.hold_close.store(true, Ordering::SeqCst);
    f.probe.mutate.store(true, Ordering::SeqCst);
    let mut record = f.record();
    let (result, ()) = tokio::join!(
        staged_save(
            &sftp,
            &replacement,
            "/note.txt",
            "/note.txt",
            "my draft",
            "original",
            &record
        ),
        async {
            f.probe.close_started.notified().await;
            assert_eq!(f.disk(), "original");
            assert_eq!(f.probe.commits.load(Ordering::SeqCst), 0);
            f.probe.release_close.notify_one();
        }
    );
    assert_eq!(result.unwrap_err().to_string(), "editor.remoteFileChanged");
    assert_eq!(f.disk(), "external change");
    assert_eq!(f.probe.commits.load(Ordering::SeqCst), 0);
    cleanup(&sftp, &mut record, |_| Ok(())).await.unwrap();
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn unacknowledged_commit_is_not_repeated_and_cleanup_leaves_published_content() {
    let f = Fixture::new();
    let sftp = f.client().await;
    let mut record = f.record();
    *f.probe.failure.lock().unwrap() = "lost-ack".into();
    assert!(staged_save(
        &sftp,
        &f.replacement().await.unwrap(),
        "/note.txt",
        "/note.txt",
        "published",
        "original",
        &record
    )
    .await
    .is_err());
    cleanup(&sftp, &mut record, |_| Ok(())).await.unwrap();
    assert_eq!(f.disk(), "published");
    assert_eq!(f.probe.commits.load(Ordering::SeqCst), 1);
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn unsupported_server_and_missing_file_are_never_recreated() {
    let f = Fixture::new();
    *f.probe.failure.lock().unwrap() = "unsupported".into();
    assert_eq!(
        f.replacement().await.err().unwrap().to_string(),
        "sftp.overwriteUnsupported"
    );
    assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 1);
    *f.probe.failure.lock().unwrap() = String::new();
    let sftp = f.client().await;
    std::fs::remove_file(f.root.join("note.txt")).unwrap();
    assert!(staged_save(
        &sftp,
        &f.replacement().await.unwrap(),
        "/note.txt",
        "/note.txt",
        "draft",
        "original",
        &f.record()
    )
    .await
    .is_err());
    assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 0);
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn cleanup_after_reconnect_checks_ownership_and_checkpoints_before_removing_marker() {
    let f = Fixture::new();
    let sftp = f.client().await;
    let mut record = f.record();
    staged_save(
        &sftp,
        &f.replacement().await.unwrap(),
        "/note.txt",
        "/note.txt",
        "saved",
        "original",
        &record,
    )
    .await
    .unwrap();
    sftp.close().await.unwrap();
    let sftp = f.client().await;
    let extra = f.root.join(".tunnelde-save-test/independent");
    std::fs::write(&extra, "preserved").unwrap();
    assert_eq!(
        cleanup(&sftp, &mut record, |_| Ok(()))
            .await
            .unwrap_err()
            .to_string(),
        "editor.cleanupUnrecognized"
    );
    assert_eq!(std::fs::read_to_string(&extra).unwrap(), "preserved");
    std::fs::remove_file(extra).unwrap();
    *f.probe.failure.lock().unwrap() = "rmdir".into();
    let checkpoint = Mutex::new(None);
    assert!(cleanup(&sftp, &mut record, |r| {
        *checkpoint.lock().unwrap() = Some(serde_json::to_string(r).unwrap());
        Ok(())
    })
    .await
    .is_err());
    let mut recovered: Record =
        serde_json::from_str(checkpoint.lock().unwrap().as_ref().unwrap()).unwrap();
    assert!(recovered.removing_marker);
    assert!(f.root.join(".tunnelde-save-test").exists());
    *f.probe.failure.lock().unwrap() = String::new();
    cleanup(&sftp, &mut recovered, |_| Ok(())).await.unwrap();
    assert!(!f.root.join(".tunnelde-save-test").exists());
    assert_eq!(f.disk(), "saved");
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn cleanup_refuses_forged_marker_or_failed_checkpoint() {
    for forged in [false, true] {
        let f = Fixture::new();
        let sftp = f.client().await;
        let mut record = f.record();
        staged_save(
            &sftp,
            &f.replacement().await.unwrap(),
            "/note.txt",
            "/note.txt",
            "saved",
            "original",
            &record,
        )
        .await
        .unwrap();
        if forged {
            std::fs::write(f.root.join(".tunnelde-save-test/owner"), "foreign").unwrap();
        }
        assert!(cleanup(&sftp, &mut record, |_| Err(AppError::internal(
            "checkpoint failed"
        )))
        .await
        .is_err());
        assert!(f.root.join(".tunnelde-save-test/owner").exists());
        assert_eq!(f.disk(), "saved");
        sftp.close().await.unwrap();
    }
}

#[test]
fn same_host_file_is_serialized_and_active_cleanup_cannot_be_reserved_twice() {
    let first = lock_for("host\0/file".into());
    let second = lock_for("host\0/file".into());
    assert!(Arc::ptr_eq(&first, &second));
    assert!(!Arc::ptr_eq(&first, &lock_for("other\0/file".into())));
    let held = Reservation::acquire("test-reservation", false).unwrap();
    assert!(Reservation::acquire("test-reservation", false).is_err());
    drop(held);
    assert!(Reservation::acquire("test-reservation", false).is_ok());
}
