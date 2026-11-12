use super::*;
use russh_sftp::protocol::*;
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

#[derive(Clone)]
struct Node(u32, &'static str);
#[derive(Default)]
struct State {
    nodes: BTreeMap<String, Node>,
    mutations: Vec<(String, String)>,
    fail: Option<String>,
    lost_reply: Option<String>,
}
struct Server {
    state: Arc<Mutex<State>>,
    directories: HashMap<String, Vec<File>>,
}
fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}
fn attrs(node: &Node) -> FileAttributes {
    let mut attrs = FileAttributes::empty();
    attrs.permissions = Some(node.0 | 0o700);
    attrs.size = Some(node.1.len() as u64);
    attrs
}
impl Server {
    fn rename(&self, from: String, to: String, replace: bool) -> Result<(), StatusCode> {
        let mut state = self.state.lock().unwrap();
        if state.fail.as_ref() == Some(&from) {
            return Err(StatusCode::PermissionDenied);
        }
        if !replace && state.nodes.contains_key(&to) {
            return Err(StatusCode::Failure);
        }
        if !state.nodes.contains_key(&from) {
            return Err(StatusCode::NoSuchFile);
        }
        if state.nodes.get(&to).is_some_and(|node| node.0 == 0o040000)
            && state
                .nodes
                .keys()
                .any(|path| path.starts_with(&format!("{to}/")))
        {
            return Err(StatusCode::Failure);
        }
        let children: Vec<_> = state
            .nodes
            .keys()
            .filter(|path| *path == &from || path.starts_with(&format!("{from}/")))
            .cloned()
            .collect();
        for path in children {
            let node = state.nodes.remove(&path).unwrap();
            state
                .nodes
                .insert(format!("{to}{}", &path[from.len()..]), node);
        }
        let lose_reply = state.lost_reply.as_ref() == Some(&from);
        state.mutations.push((from, to));
        if lose_reply {
            return Err(StatusCode::Failure);
        }
        Ok(())
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
        let state = self.state.lock().unwrap();
        Ok(Attrs {
            id,
            attrs: attrs(state.nodes.get(&path).ok_or(StatusCode::NoSuchFile)?),
        })
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        let state = self.state.lock().unwrap();
        let node = state.nodes.get(&path).ok_or(StatusCode::NoSuchFile)?;
        let canonical = if node.0 == 0o120000 {
            node.1.to_owned()
        } else {
            path
        };
        Ok(Name {
            id,
            files: vec![File::new(canonical, attrs(node))],
        })
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
        let state = self.state.lock().unwrap();
        if state.nodes.get(&path).ok_or(StatusCode::NoSuchFile)?.0 != 0o040000 {
            return Err(StatusCode::Failure);
        }
        let prefix = format!("{path}/");
        let entries = state
            .nodes
            .iter()
            .filter_map(|(child, node)| {
                let name = child.strip_prefix(&prefix)?;
                (!name.contains('/')).then(|| File::new(name, attrs(node)))
            })
            .collect();
        self.directories.insert(path.clone(), entries);
        Ok(Handle { id, handle: path })
    }
    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, StatusCode> {
        Ok(Name {
            id,
            files: self.directories.remove(&handle).ok_or(StatusCode::Eof)?,
        })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, StatusCode> {
        Ok(ok(id))
    }
    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, StatusCode> {
        let mut state = self.state.lock().unwrap();
        if state
            .nodes
            .keys()
            .any(|child| child.starts_with(&format!("{path}/")))
        {
            return Err(StatusCode::Failure);
        }
        state.nodes.remove(&path).ok_or(StatusCode::NoSuchFile)?;
        state.mutations.push((path, "rmdir".into()));
        Ok(ok(id))
    }
    async fn rename(&mut self, id: u32, from: String, to: String) -> Result<Status, StatusCode> {
        Server::rename(self, from, to, false)?;
        Ok(ok(id))
    }
    async fn extended(
        &mut self,
        id: u32,
        name: String,
        data: Vec<u8>,
    ) -> Result<Packet, StatusCode> {
        if name != "posix-rename@openssh.com" {
            return Err(StatusCode::OpUnsupported);
        }
        let mut data = data.as_slice();
        let mut paths = Vec::new();
        for _ in 0..2 {
            let mut length = [0; 4];
            std::io::Read::read_exact(&mut data, &mut length).unwrap();
            let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
            std::io::Read::read_exact(&mut data, &mut bytes).unwrap();
            paths.push(String::from_utf8(bytes).unwrap());
        }
        Server::rename(self, paths.remove(0), paths.remove(0), true)?;
        Ok(Packet::Status(ok(id)))
    }
}

struct Fixture(Arc<Mutex<State>>);
impl Fixture {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(State {
            nodes: BTreeMap::from([
                ("/".into(), Node(0o040000, "")),
                ("/source".into(), Node(0o040000, "")),
                ("/target".into(), Node(0o040000, "")),
            ]),
            ..State::default()
        })))
    }
    fn node(&self, path: &str, kind: u32, value: &'static str) {
        self.0
            .lock()
            .unwrap()
            .nodes
            .insert(path.into(), Node(kind, value));
    }
    fn file(&self, path: &str, value: &'static str) {
        self.node(path, 0o100000, value);
    }
    fn dir(&self, path: &str) {
        self.node(path, 0o040000, "");
    }
    fn value(&self, path: &str) -> Option<&'static str> {
        self.0.lock().unwrap().nodes.get(path).map(|n| n.1)
    }
    async fn stream(&self) -> tokio::io::DuplexStream {
        let (client, server) = tokio::io::duplex(65536);
        russh_sftp::server::run(
            server,
            Server {
                state: self.0.clone(),
                directories: HashMap::new(),
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
}

#[tokio::test]
async fn merges_nested_conflicts_and_moves_whole_new_subtrees_without_file_io() {
    let f = Fixture::new();
    f.dir("/source/nested");
    f.dir("/target/nested");
    f.file("/source/nested/a 中文.txt", "new");
    f.file("/target/nested/a 中文.txt", "old");
    f.file("/target/keep", "keep");
    f.dir("/source/new");
    f.file("/source/new/data", "data");
    f.node("/source/link", 0o120000, "/outside");
    let client = f.client().await;
    let plan = Plan::prepare(&client, "/source", "/target").await.unwrap();
    assert!(plan.needs_replacement);
    let replacement = f.replacement().await;
    // Reproduce the previous implementation: POSIX rename cannot merge an
    // existing nonempty directory, even though the UI promises a folder merge.
    assert!(replacement.replace("/source", "/target").await.is_err());
    assert!(f.0.lock().unwrap().mutations.is_empty());
    plan.apply(&client, Some(&replacement)).await.unwrap();
    assert_eq!(f.value("/source"), None);
    for (path, value) in [
        ("/target/nested/a 中文.txt", "new"),
        ("/target/keep", "keep"),
        ("/target/new/data", "data"),
        ("/target/link", "/outside"),
    ] {
        assert_eq!(f.value(path), Some(value));
    }
    let state = f.0.lock().unwrap();
    assert!(state
        .mutations
        .contains(&("/source/new".into(), "/target/new".into())));
    assert_eq!(state.mutations.len(), 5);
}

#[tokio::test]
async fn rejects_all_structural_conflicts_before_any_mutation() {
    for target_dir in [true, false] {
        let f = Fixture::new();
        f.file("/source/ready", "move");
        if target_dir {
            f.file("/source/conflict", "file");
            f.dir("/target/conflict");
        } else {
            f.dir("/source/conflict");
            f.file("/target/conflict", "file");
        }
        let client = f.client().await;
        assert!(
            matches!(Plan::prepare(&client, "/source", "/target").await, Err(AppError::Validation(key)) if key == "sftp.typeConflict")
        );
        assert!(f.0.lock().unwrap().mutations.is_empty());
    }
}

#[tokio::test]
async fn unsupported_overwrite_leaves_even_nonconflicting_files_untouched() {
    let f = Fixture::new();
    f.file("/source/a", "new");
    f.file("/target/a", "old");
    f.file("/source/b", "b");
    let client = f.client().await;
    let plan = Plan::prepare(&client, "/source", "/target").await.unwrap();
    assert_eq!(
        plan.apply(&client, None).await.unwrap_err().to_string(),
        "sftp.overwriteUnsupported"
    );
    assert!(f.0.lock().unwrap().mutations.is_empty());
    assert_eq!(f.value("/target/a"), Some("old"));
}

#[tokio::test]
async fn retains_new_source_entries_and_can_retry_a_partial_merge() {
    let f = Fixture::new();
    f.file("/source/a", "a");
    f.file("/source/z", "z");
    let client = f.client().await;
    let plan = Plan::prepare(&client, "/source", "/target").await.unwrap();
    f.file("/source/added", "added");
    assert!(plan.apply(&client, None).await.is_err());
    assert_eq!(f.value("/source/added"), Some("added"));
    assert_eq!(f.value("/target/a"), Some("a"));
    Plan::prepare(&client, "/source", "/target")
        .await
        .unwrap()
        .apply(&client, None)
        .await
        .unwrap();
    assert_eq!(f.value("/source"), None);
    assert_eq!(f.value("/target/added"), Some("added"));
}

#[tokio::test]
async fn preserves_a_new_destination_and_refuses_a_substituted_directory() {
    for symlink in [false, true] {
        let f = Fixture::new();
        f.file("/source/a", "source");
        let client = f.client().await;
        let plan = Plan::prepare(&client, "/source", "/target").await.unwrap();
        if symlink {
            f.node("/target", 0o120000, "/outside");
        } else {
            f.file("/target/a", "concurrent");
        }
        assert!(plan.apply(&client, None).await.is_err());
        assert_eq!(f.value("/source/a"), Some("source"));
        assert!(f.0.lock().unwrap().mutations.is_empty());
    }
}

#[tokio::test]
async fn reports_failed_entry_and_keeps_remaining_sources_on_a_partial_failure() {
    let f = Fixture::new();
    f.file("/source/a", "a");
    f.file("/source/z", "z");
    f.0.lock().unwrap().fail = Some("/source/a".into());
    let client = f.client().await;
    let plan = Plan::prepare(&client, "/source", "/target").await.unwrap();
    let error = serde_json::to_value(plan.apply(&client, None).await.unwrap_err()).unwrap();
    assert_eq!(error["details"]["from"], "/source/a");
    assert_eq!(error["details"]["to"], "/target/a");
    assert_eq!(f.value("/source/a"), Some("a"));
    assert_eq!(f.value("/target/z"), Some("z"));
    f.0.lock().unwrap().fail = None;
    Plan::prepare(&client, "/source", "/target")
        .await
        .unwrap()
        .apply(&client, None)
        .await
        .unwrap();
    assert_eq!(f.value("/source"), None);
}

#[tokio::test]
async fn rejects_overlapping_roots_before_traversal() {
    let f = Fixture::new();
    let client = f.client().await;
    for (from, to) in [
        ("/source", "/source"),
        ("/source", "/source/child"),
        ("/source/child", "/source"),
    ] {
        assert!(
            matches!(Plan::prepare(&client, from, to).await, Err(AppError::Validation(key)) if key == "sftp.samePath")
        );
    }
}

#[tokio::test]
async fn lost_acknowledgement_is_not_replayed_when_the_remaining_merge_is_retried() {
    let f = Fixture::new();
    f.file("/source/a", "a");
    f.file("/source/z", "z");
    f.0.lock().unwrap().lost_reply = Some("/source/z".into());
    let client = f.client().await;
    let plan = Plan::prepare(&client, "/source", "/target").await.unwrap();
    assert!(plan.apply(&client, None).await.is_err());
    assert_eq!(f.value("/source/z"), None);
    assert_eq!(f.value("/target/z"), Some("z"));
    assert_eq!(f.value("/source/a"), Some("a"));
    // A missing reply does not authorize rewriting an already moved item.
    f.file("/target/z", "edited after lost reply");
    Plan::prepare(&client, "/source", "/target")
        .await
        .unwrap()
        .apply(&client, None)
        .await
        .unwrap();
    assert_eq!(f.value("/target/z"), Some("edited after lost reply"));
    assert_eq!(f.value("/target/a"), Some("a"));
}

#[tokio::test]
async fn deep_merges_and_missing_file_type_metadata_fail_without_mutation() {
    let f = Fixture::new();
    let mut from = "/source".to_owned();
    let mut to = "/target".to_owned();
    for _ in 0..=MAX_DEPTH {
        from.push_str("/child");
        to.push_str("/child");
        f.dir(&from);
        f.dir(&to);
    }
    let client = f.client().await;
    assert!(matches!(Plan::prepare(&client, "/source", "/target").await,
        Err(AppError::Validation(key)) if key == "sftp.mergeTooLarge"));
    assert!(f.0.lock().unwrap().mutations.is_empty());

    let f = Fixture::new();
    f.node("/source/unknown", 0, "data");
    let client = f.client().await;
    assert!(matches!(Plan::prepare(&client, "/source", "/target").await,
        Err(AppError::Validation(key)) if key == "sftp.fileMetadataMissing"));
    assert!(f.0.lock().unwrap().mutations.is_empty());
}

#[tokio::test]
async fn revocation_between_merge_steps_stops_before_the_next_mutation() {
    let fixture = Fixture::new();
    fixture.file("/source/a", "a");
    fixture.file("/source/b", "b");
    let client = fixture.client().await;
    let plan = Plan::prepare(&client, "/source", "/target").await.unwrap();
    let state = fixture.0.clone();
    let dispatch = mutations::Dispatch::new(
        move || {
            if state.lock().unwrap().mutations.is_empty() {
                Ok(())
            } else {
                Err(AppError::validation("pluginSecurity.changed"))
            }
        },
        native_save::runtime::MutationObservation::default(),
    );
    let error = plan
        .apply_guarded(&client, None, Some(&dispatch))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "pluginSecurity.changed");
    assert_eq!(fixture.0.lock().unwrap().mutations.len(), 1);
    assert!(fixture.value("/source").is_some());
    assert_eq!(
        [fixture.value("/source/a"), fixture.value("/source/b")]
            .iter()
            .filter(|value| value.is_some())
            .count(),
        1
    );
    client.close().await.unwrap();
}
