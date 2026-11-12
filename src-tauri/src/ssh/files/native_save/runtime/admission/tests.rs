use super::*;
use crate::ssh::files::native_save::{
    contracts::operation::{Baseline, Prepared},
    journal::Journal,
    testing::{authority, binding},
};
use russh_sftp::protocol::{File, FileAttributes, Name};
use std::{collections::HashMap, sync::atomic::AtomicUsize};
mod desktop;
mod mutation;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("tunnelde-fence-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn journal(&self) -> Journal {
        Journal::create(&self.0.join("native-file-saves")).unwrap()
    }
    fn manager(&self) -> Arc<Manager> {
        Arc::new(Manager::new(&self.0, "dev.tunnelde.qa.file-fence"))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
struct Server {
    paths: HashMap<String, Result<String, StatusCode>>,
    probes: Arc<AtomicUsize>,
    gate: Option<Arc<Semaphore>>,
}
impl russh_sftp::server::Handler for Server {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        self.probes.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.gate {
            gate.acquire().await.unwrap().forget();
        }
        let canonical = self
            .paths
            .get(&path)
            .cloned()
            .unwrap_or(Err(StatusCode::NoSuchFile))?;
        Ok(Name {
            id,
            files: vec![File::new(canonical, FileAttributes::empty())],
        })
    }
}
async fn server(
    paths: &[(&str, Result<&str, StatusCode>)],
    gate: Option<Arc<Semaphore>>,
) -> (SftpSession, Arc<AtomicUsize>) {
    let probes = Arc::new(AtomicUsize::new(0));
    let (client, stream) = tokio::io::duplex(8192);
    russh_sftp::server::run(
        stream,
        Server {
            paths: paths
                .iter()
                .map(|(path, result)| (path.to_string(), result.map(str::to_owned)))
                .collect(),
            probes: probes.clone(),
            gate,
        },
    )
    .await;
    (SftpSession::new(client).await.unwrap(), probes)
}
fn reserve(journal: &mut Journal) -> SessionIdentity {
    let authority = authority();
    let prepared = Prepared::new(
        &authority,
        vec!["tree".into(), "note.json".into()],
        Baseline::Absent,
        "{}".into(),
    )
    .unwrap();
    journal
        .reserve(binding(&authority, &prepared))
        .unwrap()
        .binding
        .destination
}

#[tokio::test]
async fn existing_native_record_blocks_parent_target_descendant_and_host_alias() {
    let fixture = Fixture::new();
    let mut journal = fixture.journal();
    let destination = reserve(&mut journal);
    let manager = fixture.manager();
    let (sftp, probes) = server(&[], None).await;
    for path in [
        "/workspace",
        "/workspace/tree",
        "/workspace/tree/note.json",
        "/workspace/tree/note.json/child",
        "/qa/state",
        "/qa/state/receipt.sqlite3",
        "/qa/agent",
    ] {
        let error = manager
            .writable(&destination, &sftp, &[path])
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "editor.remoteOutcomeUnknown");
    }
    let mut alias = destination.clone();
    alias.address = "another-account@alias.invalid:22".into();
    alias.host_id = "different-saved-host".into();
    assert!(manager
        .writable(&alias, &sftp, &["/workspace/tree"])
        .await
        .is_err());
    assert_eq!(probes.load(Ordering::SeqCst), 0);
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn canonical_alias_and_missing_descendants_are_checked_without_mutation() {
    let fixture = Fixture::new();
    let mut journal = fixture.journal();
    let destination = reserve(&mut journal);
    let manager = fixture.manager();
    let (sftp, probes) = server(
        &[
            ("/alias", Ok("/workspace/tree/note.json")),
            ("/other", Ok("/workspace/tree-other")),
            (r"/literal\", Ok(r"/workspace/literal\")),
        ],
        None,
    )
    .await;
    assert!(manager
        .writable(&destination, &sftp, &["/alias/new/deep/file"])
        .await
        .is_err());
    manager
        .writable(&destination, &sftp, &["/other/new/file"])
        .await
        .unwrap();
    // Backslashes in POSIX parent names stay literal, rather than separators.
    assert_eq!(
        resolve(&sftp, r"/literal\/new").await.unwrap(),
        "/workspace/literal\\/new"
    );
    assert!(probes.load(Ordering::SeqCst) > 0);
    // This SFTP fixture implements no mutation requests; successful checks only probe.
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn unrelated_hosts_and_missing_storage_do_not_add_remote_probes_or_initialize() {
    let fixture = Fixture::new();
    let manager = fixture.manager();
    let mut destination = binding(
        &authority(),
        &crate::ssh::files::native_save::testing::prepared(&authority()),
    )
    .destination;
    let (sftp, probes) = server(&[], None).await;
    manager
        .writable(&destination, &sftp, &["/workspace/tree"])
        .await
        .unwrap();
    assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 0);
    let mut journal = fixture.journal();
    reserve(&mut journal);
    destination.host_id = "independent-host".into();
    destination.address = "independent@other.invalid:22".into();
    destination.server_key = format!("SHA256:{}", "B".repeat(43));
    manager
        .writable(&destination, &sftp, &["/workspace/tree"])
        .await
        .unwrap();
    assert_eq!(probes.load(Ordering::SeqCst), 0);
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn failed_alias_resolution_and_corrupt_journal_never_permit_a_fallback_write() {
    let fixture = Fixture::new();
    let mut journal = fixture.journal();
    let destination = reserve(&mut journal);
    drop(journal);
    let manager = fixture.manager();
    let (sftp, _) = server(&[("/permission", Err(StatusCode::PermissionDenied))], None).await;
    assert!(manager
        .writable(&destination, &sftp, &["/permission/file"])
        .await
        .is_err());
    let conn =
        rusqlite::Connection::open(fixture.0.join("native-file-saves/recovery.sqlite3")).unwrap();
    conn.execute("UPDATE records SET digest='damaged'", [])
        .unwrap();
    drop(conn);
    assert_eq!(
        manager
            .writable(&destination, &sftp, &["/unrelated"])
            .await
            .unwrap_err()
            .to_string(),
        "editor.nativeJournalUnavailable"
    );
    drop(manager);
    assert!(fixture
        .manager()
        .writable(&destination, &sftp, &["/unrelated"])
        .await
        .is_err());
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn cancelling_a_probe_does_not_retire_the_original_reservation() {
    let fixture = Fixture::new();
    let mut journal = fixture.journal();
    let destination = reserve(&mut journal);
    let gate = Arc::new(Semaphore::new(0));
    let (sftp, probes) = server(&[("/alias", Ok("/workspace/tree"))], Some(gate.clone())).await;
    let sftp = Arc::new(sftp);
    let manager = fixture.manager();
    let worker = {
        let sftp = sftp.clone();
        let manager = manager.clone();
        let destination = destination.clone();
        tokio::spawn(async move { manager.writable(&destination, &sftp, &["/alias"]).await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while probes.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    gate.add_permits(1);
    assert!(fixture
        .manager()
        .writable(&destination, &sftp, &["/workspace/tree"])
        .await
        .is_err());
    assert_eq!(journal.records().unwrap().len(), 1);
    sftp.close().await.unwrap();
}
