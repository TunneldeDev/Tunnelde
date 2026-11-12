use super::*;
use crate::ssh::files::native_save::testing::*;
mod continuation;
mod crash;

struct Fixture {
    root: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("tunnelde-legacy-journal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self { root }
    }
    fn path(&self) -> std::path::PathBuf {
        self.root.join("native-file-saves")
    }
    fn create(&self) -> Journal {
        Journal::create(&self.path()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

fn owner() -> Owner {
    Owner {
        id: uuid::Uuid::new_v4().to_string(),
        generation: uuid::Uuid::new_v4().to_string(),
    }
}
fn scope(path: &str) -> Scope {
    let authority = authority();
    Scope {
        destination: binding(&authority, &prepared(&authority)).destination,
        platform: "posix".into(),
        paths: vec![path.into()],
    }
}
fn native(journal: &mut Journal, path: &str) -> Result<super::super::Record> {
    let authority = authority();
    let mut prepared = prepared(&authority);
    prepared.intent.target = path.split('/').map(String::from).collect();
    prepared.control.intent_sha256 = prepared.intent.digest();
    journal.reserve(binding(&authority, &prepared))
}

#[test]
fn explicit_upgrade_preserves_v1_records_and_does_not_run_during_open() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    let original = native(&mut journal, "retained").unwrap();
    assert!(journal.legacy_claims().unwrap().is_empty());
    assert!(matches!(
        journal.reserve_legacy(Kind::Create, owner(), vec![scope("/elsewhere")]),
        Err(Error::Unrecognized)
    ));
    drop(journal);
    let mut journal = Journal::open(&fixture.path()).unwrap();
    assert_eq!(
        journal
            .conn
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    journal.enable_admission().unwrap();
    assert!(journal.current(&original).is_ok());
    journal.enable_admission().unwrap();
    drop(journal);
    let reopened = Journal::open(&fixture.path()).unwrap();
    assert!(reopened.current(&original).is_ok());
}

#[test]
fn native_and_legacy_arbitrate_ancestors_aliases_helper_and_both_directions() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let legacy = journal
        .reserve_legacy(Kind::Delete, owner(), vec![scope("/workspace/tree")])
        .unwrap();
    assert!(matches!(
        native(&mut journal, "tree/child"),
        Err(Error::Occupied)
    ));
    let mut alias = scope("/workspace/tree/child");
    alias.destination.host_id = "alias".into();
    alias.destination.address = "other@alias:22".into();
    assert!(matches!(
        journal.reserve_legacy(Kind::Editor, owner(), vec![alias]),
        Err(Error::Occupied)
    ));
    let unrelated = journal
        .reserve_legacy(Kind::Create, owner(), vec![scope("/workspace/tree-other")])
        .unwrap();
    journal.retire_unsent_legacy(&unrelated).unwrap();
    journal.retire_unsent_legacy(&legacy).unwrap();
    let record = native(&mut journal, "tree/child").unwrap();
    for path in [
        "/workspace/tree",
        "/workspace/tree/child",
        "/workspace/tree/child/next",
        &record.binding.selection.directory,
        &record.binding.selection.executable,
    ] {
        assert!(
            matches!(
                journal.reserve_legacy(Kind::Delete, owner(), vec![scope(path)]),
                Err(Error::Occupied)
            ),
            "{path}"
        );
    }
    let mut other = scope("/workspace/tree");
    other.destination.host_id = "other".into();
    other.destination.address = "user@other:22".into();
    other.destination.server_key = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA".into();
    journal
        .reserve_legacy(Kind::Delete, owner(), vec![other])
        .unwrap();
}

#[test]
fn independent_connections_race_native_and_legacy_with_one_winner() {
    for _ in 0..8 {
        let fixture = Fixture::new();
        let mut journal = fixture.create();
        journal.enable_admission().unwrap();
        drop(journal);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut workers = Vec::new();
        for native_writer in [true, false] {
            let path = fixture.path();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                let mut journal = Journal::open(&path).unwrap();
                barrier.wait();
                if native_writer {
                    native(&mut journal, "tree/child").map(|_| ())
                } else {
                    journal
                        .reserve_legacy(Kind::Rename, owner(), vec![scope("/workspace/tree")])
                        .map(|_| ())
                }
            }));
        }
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Err(Error::Occupied)))
                .count(),
            1
        );
    }
}

#[test]
fn dispatch_is_single_use_retirement_cannot_erase_possible_dispatch() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let original = journal
        .reserve_legacy(Kind::Create, owner(), vec![scope("/workspace/file")])
        .unwrap();
    let mut stale = original.clone();
    stale.owner.generation = uuid::Uuid::new_v4().to_string();
    assert!(journal.dispatch_legacy(&stale).is_err());
    let permit = journal.dispatch_legacy(&original).unwrap();
    let dispatched = permit.claim().clone();
    assert!(journal.dispatch_legacy(&original).is_err());
    assert!(journal.retire_unsent_legacy(&original).is_err());
    assert!(journal.retire_unsent_legacy(&dispatched).is_err());
    assert!(matches!(native(&mut journal, "file"), Err(Error::Occupied)));
    journal.settle_legacy(permit).unwrap();
    assert!(journal.legacy_claims().unwrap().is_empty());
    native(&mut journal, "file").unwrap();
}

#[test]
fn combined_quota_counts_native_and_legacy_and_unknowns_never_expire() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    for i in 0..4 {
        let claim = journal
            .reserve_legacy(
                Kind::Transfer,
                owner(),
                vec![scope(&format!("/workspace/legacy-{i}"))],
            )
            .unwrap();
        drop(journal.dispatch_legacy(&claim).unwrap());
    }
    let original = native(&mut journal, "native").unwrap();
    let ready = journal.ready(&original).unwrap();
    assert!(matches!(journal.dispatch(&ready), Err(Error::Capacity)));
    for i in 4..127 {
        journal
            .reserve_legacy(
                Kind::Create,
                owner(),
                vec![scope(&format!("/workspace/legacy-{i}"))],
            )
            .unwrap();
    }
    assert!(matches!(
        native(&mut journal, "overflow"),
        Err(Error::Capacity)
    ));
    assert!(matches!(
        journal.reserve_legacy(Kind::Delete, owner(), vec![scope("/workspace/overflow")]),
        Err(Error::Capacity)
    ));
    drop(journal);
    let journal = Journal::open(&fixture.path()).unwrap();
    assert_eq!(journal.legacy_claims().unwrap().len(), 127);
}

#[test]
fn tampering_malformed_scope_and_partial_upgrade_fail_without_reset() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    for path in ["relative", "/bad\0path"] {
        assert!(journal
            .reserve_legacy(Kind::Create, owner(), vec![scope(path)])
            .is_err());
    }
    let claim = journal
        .reserve_legacy(Kind::Delete, owner(), vec![scope("/workspace/original")])
        .unwrap();
    journal
        .conn
        .execute("UPDATE legacy_claims SET digest='bad'", [])
        .unwrap();
    assert!(journal.records().is_err());
    assert!(journal.legacy_claims().is_err());
    assert!(journal.enable_admission().is_err());
    assert!(native(&mut journal, "unrelated").is_err());
    assert!(journal.dispatch_legacy(&claim).is_err());
    drop(journal);
    let bytes = std::fs::read(fixture.path().join("recovery.sqlite3")).unwrap();
    assert!(Journal::open(&fixture.path()).is_err());
    assert_eq!(
        std::fs::read(fixture.path().join("recovery.sqlite3")).unwrap(),
        bytes
    );
}

#[test]
fn downgraded_schema_never_hides_existing_claims_on_open_or_live_connection() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let original = journal
        .reserve_legacy(Kind::Delete, owner(), vec![scope("/workspace/original")])
        .unwrap();
    let external = rusqlite::Connection::open(fixture.path().join("recovery.sqlite3")).unwrap();
    external.pragma_update(None, "user_version", 1).unwrap();
    assert!(journal.records().is_err());
    assert!(journal.legacy_claims().is_err());
    assert!(journal.dispatch_legacy(&original).is_err());
    assert!(Journal::open(&fixture.path()).is_err());
    external.pragma_update(None, "user_version", 2).unwrap();
    drop(external);
    assert!(journal.legacy_claims().unwrap() == [original]);
}

#[test]
fn windows_scopes_respect_sftp_spelling_and_posix_paths_stay_case_sensitive() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let mut original = scope(r"C:\Work\Data");
    original.platform = "windows".into();
    journal
        .reserve_legacy(Kind::Delete, owner(), vec![original.clone()])
        .unwrap();
    for path in ["/c:/work/data/file", r"\\?\C:\WORK\DATA", "C:/work"] {
        let mut candidate = original.clone();
        candidate.paths = vec![path.into()];
        assert!(matches!(
            journal.reserve_legacy(Kind::Create, owner(), vec![candidate]),
            Err(Error::Occupied)
        ));
    }
    let mut separate = original;
    separate.paths = vec!["C:/work/data-other".into()];
    journal
        .reserve_legacy(Kind::Create, owner(), vec![separate])
        .unwrap();
    // A changed namespace on a potentially identical host cannot prove disjointness.
    assert!(matches!(
        journal.reserve_legacy(Kind::Delete, owner(), vec![scope("/unrelated")]),
        Err(Error::Occupied)
    ));
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    journal
        .reserve_legacy(Kind::Delete, owner(), vec![scope("/workspace/A")])
        .unwrap();
    journal
        .reserve_legacy(Kind::Delete, owner(), vec![scope("/workspace/a")])
        .unwrap();
}
