use super::*;
use russh_sftp::protocol::*;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

type Files = Arc<Mutex<HashMap<String, Vec<u8>>>>;

struct Probe {
    mode: u8, // 1: hold before rename, 2: hold acknowledgement, 3: lose reply
    destination: &'static str,
    once: AtomicBool,
    arrived: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
    finished: tokio::sync::Semaphore,
}

struct Server {
    files: Files,
    probe: Arc<Probe>,
}

fn status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}

impl Server {
    async fn move_file(&self, from: String, to: String, replace: bool) -> Result<(), StatusCode> {
        let held = from == "/stage"
            && to == self.probe.destination
            && !self.probe.once.swap(true, Ordering::SeqCst);
        if held && self.probe.mode == 1 {
            self.probe.arrived.add_permits(1);
            self.probe.release.acquire().await.unwrap().forget();
        }
        let result = {
            let mut files = self.files.lock().unwrap();
            if !replace && files.contains_key(&to) {
                Err(StatusCode::Failure)
            } else {
                files
                    .remove(&from)
                    .map(|data| {
                        files.insert(to, data);
                    })
                    .ok_or(StatusCode::NoSuchFile)
            }
        };
        if held && self.probe.mode == 2 {
            self.probe.arrived.add_permits(1);
            self.probe.release.acquire().await.unwrap().forget();
        }
        if held {
            self.probe.finished.add_permits(1);
        }
        if held && self.probe.mode == 3 {
            return Err(StatusCode::Failure);
        }
        result
    }
}

impl russh_sftp::server::Handler for Server {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn init(&mut self, _: u32, _: HashMap<String, String>) -> Result<Version, StatusCode> {
        let mut version = Version::new();
        version
            .extensions
            .insert("posix-rename@openssh.com".into(), "1".into());
        Ok(version)
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        let files = self.files.lock().unwrap();
        let data = files.get(&path).ok_or(StatusCode::NoSuchFile)?;
        let mut attrs = FileAttributes::empty();
        attrs.size = Some(data.len() as u64);
        attrs.permissions = Some(0o100600);
        Ok(Attrs { id, attrs })
    }
    async fn rename(&mut self, id: u32, from: String, to: String) -> Result<Status, StatusCode> {
        self.move_file(from, to, false).await?;
        Ok(status(id))
    }
    async fn extended(
        &mut self,
        id: u32,
        request: String,
        data: Vec<u8>,
    ) -> Result<Packet, StatusCode> {
        if request != "posix-rename@openssh.com" {
            return Err(StatusCode::OpUnsupported);
        }
        let mut input = data.as_slice();
        let mut names = Vec::new();
        for _ in 0..2 {
            let mut length = [0; 4];
            std::io::Read::read_exact(&mut input, &mut length)
                .map_err(|_| StatusCode::BadMessage)?;
            let mut value = vec![0; u32::from_be_bytes(length) as usize];
            std::io::Read::read_exact(&mut input, &mut value)
                .map_err(|_| StatusCode::BadMessage)?;
            names.push(String::from_utf8(value).map_err(|_| StatusCode::BadMessage)?);
        }
        self.move_file(names.remove(0), names.remove(0), true)
            .await?;
        Ok(Packet::Status(status(id)))
    }
}

struct Fixture {
    files: Files,
    probe: Arc<Probe>,
}
impl Fixture {
    fn new(mode: u8, destination: &'static str) -> Self {
        Self {
            files: Arc::new(Mutex::new(HashMap::from([(
                "/stage".into(),
                b"complete upload".to_vec(),
            )]))),
            probe: Arc::new(Probe {
                mode,
                destination,
                once: AtomicBool::new(false),
                arrived: tokio::sync::Semaphore::new(0),
                release: tokio::sync::Semaphore::new(0),
                finished: tokio::sync::Semaphore::new(0),
            }),
        }
    }
    async fn stream(&self) -> tokio::io::DuplexStream {
        let (client, server) = tokio::io::duplex(65536);
        russh_sftp::server::run(
            server,
            Server {
                files: self.files.clone(),
                probe: self.probe.clone(),
            },
        )
        .await;
        client
    }
    async fn client(&self) -> SftpSession {
        SftpSession::new(self.stream().await).await.unwrap()
    }
    async fn replacement(&self) -> remote_commit::Replacement {
        remote_commit::Replacement::negotiate(russh_sftp::client::RawSftpSession::new(
            self.stream().await,
        ))
        .await
        .unwrap()
    }
    fn data(&self, name: &str) -> Option<Vec<u8>> {
        self.files.lock().unwrap().get(name).cloned()
    }
}

fn endpoint(path: &str) -> Endpoint {
    Endpoint {
        session: Some("test".into()),
        path: path.into(),
    }
}

async fn interrupted_publication(overwrite: bool, after_commit: bool) {
    let fixture = Fixture::new(if after_commit { 2 } else { 1 }, "/target");
    if overwrite {
        fixture
            .files
            .lock()
            .unwrap()
            .insert("/target".into(), b"original target".to_vec());
    }
    let client = fixture.client().await;
    let replacement = if overwrite {
        Some(fixture.replacement().await)
    } else {
        None
    };
    let cancel = AtomicBool::new(false);
    let old = endpoint("/stage");
    let target = endpoint("/target");
    let next = endpoint("/next");
    let operation = async {
        if let Some(replacement) = replacement {
            interruptible(Some(&cancel), replacement.commit(&old.path, &target.path)).await
        } else {
            commit(&old, &target, Some(&client), &cancel).await
        }
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(1), async {
        tokio::join!(operation, async {
            fixture.probe.arrived.acquire().await.unwrap().forget();
            cancel.store(true, Ordering::SeqCst);
        })
    })
    .await
    .expect("pause waited for publication acknowledgement");
    assert_eq!(result.unwrap_err().to_string(), CANCELLED);
    let resumed = fixture.client().await;
    let cancel = AtomicBool::new(false);
    assert_eq!(
        fence(&old, &next, &resumed, &cancel).await.unwrap(),
        !after_commit
    );
    if after_commit {
        assert_eq!(fixture.data("/target").unwrap(), b"complete upload");
        assert!(fixture.data("/next").is_none());
    } else {
        assert_eq!(fixture.data("/next").unwrap(), b"complete upload");
        assert!(fixture.data("/stage").is_none());
    }
    // Emulate a successful resumed publication or a subsequent user edit. The
    // delayed original operation must not replace these newer contents.
    fixture
        .files
        .lock()
        .unwrap()
        .insert("/target".into(), b"newer target contents".to_vec());
    fixture.probe.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(1), fixture.probe.finished.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert_eq!(fixture.data("/target").unwrap(), b"newer target contents");
}

#[tokio::test]
async fn delayed_noreplace_commit_is_fenced_before_resume() {
    interrupted_publication(false, false).await
}
#[tokio::test]
async fn delayed_overwrite_commit_cannot_replace_resumed_or_user_contents() {
    interrupted_publication(true, false).await
}
#[tokio::test]
async fn lost_noreplace_acknowledgement_is_reconciled_without_reupload() {
    interrupted_publication(false, true).await
}
#[tokio::test]
async fn lost_overwrite_acknowledgement_preserves_later_user_edit() {
    interrupted_publication(true, true).await
}

#[tokio::test]
async fn lost_fencing_acknowledgement_reuses_journalled_successor() {
    let fixture = Fixture::new(3, "/next");
    let client = fixture.client().await;
    let old = endpoint("/stage");
    let next = endpoint("/next");
    let cancel = AtomicBool::new(false);
    assert!(fence(&old, &next, &client, &cancel).await.is_err());
    let restarted = fixture.client().await;
    assert!(fence(&old, &next, &restarted, &cancel).await.unwrap());
    assert_eq!(fixture.data("/next").unwrap(), b"complete upload");
    assert!(fixture.data("/stage").is_none());
}

#[tokio::test]
async fn duplicate_staging_paths_are_preserved_for_review() {
    let fixture = Fixture::new(0, "/target");
    fixture
        .files
        .lock()
        .unwrap()
        .insert("/next".into(), b"independent".to_vec());
    let client = fixture.client().await;
    let cancel = AtomicBool::new(false);
    let result = fence(&endpoint("/stage"), &endpoint("/next"), &client, &cancel).await;
    assert!(matches!(
        result,
        Err(AppError::TransferArtifactUnrecognized { .. })
    ));
    assert_eq!(fixture.data("/stage").unwrap(), b"complete upload");
    assert_eq!(fixture.data("/next").unwrap(), b"independent");
    assert!(
        fence(&endpoint("/stage"), &endpoint("/stage"), &client, &cancel)
            .await
            .is_err()
    );
}
