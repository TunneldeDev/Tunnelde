use super::*;
use crate::ssh::files::native_save::{contracts::receipt::Observation, testing::*};
use std::path::PathBuf;
mod crash;
mod finalization;

struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("tunnelde-journal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self { root }
    }
    fn path(&self) -> PathBuf {
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

fn receipt(record: &Record, phase: &str, revision: u64) -> Observation {
    // Test producer uses the original operation identity without ever persisting its token.
    let mut prepared = prepared(&record.binding.authority);
    prepared.control.operation_id = record.binding.operation_id.clone();
    prepared.control.generation = record.binding.generation.clone();
    prepared.control.intent_sha256 = record.binding.intent_sha256.clone();
    let control = prepared.control;
    serde_json::from_value(
        response(&record.binding.authority, Some(&control), phase, revision)["observation"].clone(),
    )
    .unwrap()
}
fn reserve(journal: &mut Journal, name: &str) -> Record {
    let authority = authority();
    let mut prepared = prepared(&authority);
    prepared.intent.target = vec![name.into()];
    prepared.control.intent_sha256 = prepared.intent.digest();
    journal.reserve(binding(&authority, &prepared)).unwrap()
}

#[test]
fn dispatch_is_once_only_and_survives_reopening_without_payload_or_token() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    let authority = authority();
    let prepared = prepared(&authority);
    let record = journal.reserve(binding(&authority, &prepared)).unwrap();
    assert!(journal.dispatch(&record).is_err());
    let ready = journal.ready(&record).unwrap();
    assert!(journal.ready(&record).is_err());
    let (dispatched, permit) = journal.dispatch(&ready).unwrap();
    assert!(permit.matches(&authority, &prepared));
    assert!(journal.dispatch(&ready).is_err());
    let bytes = std::fs::read(fixture.path().join("recovery.sqlite3")).unwrap();
    assert!(!bytes
        .windows(prepared.control.token.len())
        .any(|window| window == prepared.control.token.as_bytes()));
    assert!(!bytes
        .windows(prepared.content.len())
        .any(|window| window == prepared.content.as_bytes()));
    drop(journal);
    let mut reopened = Journal::open(&fixture.path()).unwrap();
    assert!(reopened.current(&dispatched).is_ok());
    assert!(reopened.dispatch(&dispatched).is_err());
    assert!(reopened
        .reserve(binding(
            &authority,
            &super::super::testing::prepared(&authority)
        ))
        .is_err());
}

#[test]
fn stale_owner_revision_intent_and_remote_receipt_cannot_replace_current() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    let record = reserve(&mut journal, "original");
    let mut changed = record.clone();
    changed.binding.owner.generation = uuid::Uuid::new_v4().to_string();
    assert!(journal.ready(&changed).is_err());
    let ready = journal.ready(&record).unwrap();
    let (dispatched, _) = journal.dispatch(&ready).unwrap();
    let mut wrong = receipt(&dispatched, "succeeded", 3);
    wrong.intent_sha256 = "0".repeat(64);
    assert!(journal.observe(&dispatched, wrong).is_err());
    let settled = journal
        .observe(&dispatched, receipt(&dispatched, "succeeded", 3))
        .unwrap();
    assert!(journal
        .observe(&dispatched, receipt(&dispatched, "unknown", 4))
        .is_err());
    assert!(journal
        .observe(&settled, receipt(&settled, "failed", 4))
        .is_err());
    assert!(journal
        .observe(&settled, receipt(&settled, "succeeded", 2))
        .is_err());
}

#[test]
fn two_connections_race_on_the_same_cas_and_path_admission() {
    let fixture = Fixture::new();
    let mut first = fixture.create();
    let mut second = Journal::open(&fixture.path()).unwrap();
    let record = reserve(&mut first, "same");
    assert!(second.reserve(record.binding.clone()).is_err());
    let ready = first.ready(&record).unwrap();
    assert!(second.ready(&record).is_err());
    first.dispatch(&ready).unwrap();
    assert!(second.dispatch(&ready).is_err());
}

#[test]
fn unknown_work_and_lost_cleanup_retain_capacity_and_target_reservation() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    let mut active = Vec::new();
    for name in ["one", "two", "three", "four"] {
        let record = reserve(&mut journal, name);
        let ready = journal.ready(&record).unwrap();
        active.push(journal.dispatch(&ready).unwrap().0);
    }
    let fifth = reserve(&mut journal, "five");
    let fifth = journal.ready(&fifth).unwrap();
    assert!(matches!(journal.dispatch(&fifth), Err(Error::Capacity)));
    let old = &active[0];
    let terminal = journal.observe(old, receipt(old, "conflict", 4)).unwrap();
    assert!(journal.release(&terminal, false).is_err());
    let releasing = journal.release(&terminal, true).unwrap();
    assert!(matches!(journal.dispatch(&fifth), Err(Error::Capacity)));
    assert!(journal.release(&releasing, true).is_err());
    let released = journal
        .observe(&releasing, receipt(&releasing, "released", 5))
        .unwrap();
    assert!(released.released());
    journal.dispatch(&fifth).unwrap();
    let mut binding = released.binding.clone();
    binding.operation_id = uuid::Uuid::new_v4().to_string();
    journal.reserve(binding).unwrap();
}

#[test]
fn corruption_missing_storage_and_foreign_databases_are_never_reset() {
    let fixture = Fixture::new();
    assert!(Journal::open(&fixture.path()).is_err());
    assert!(!fixture.path().exists());
    let journal = fixture.create();
    drop(journal);
    let database = fixture.path().join("recovery.sqlite3");
    for bytes in [Vec::new(), b"corrupt retained evidence".to_vec()] {
        std::fs::write(&database, &bytes).unwrap();
        assert!(Journal::open(&fixture.path()).is_err());
        assert!(Journal::create(&fixture.path()).is_err());
        assert_eq!(std::fs::read(&database).unwrap(), bytes);
    }
    std::fs::remove_file(&database).unwrap();
    assert!(Journal::open(&fixture.path()).is_err());
    assert!(!database.exists());
    let foreign = rusqlite::Connection::open(&database).unwrap();
    foreign
        .execute_batch("CREATE TABLE keep(value TEXT); INSERT INTO keep VALUES('evidence');")
        .unwrap();
    drop(foreign);
    let before = std::fs::read(&database).unwrap();
    assert!(Journal::open(&fixture.path()).is_err());
    assert_eq!(std::fs::read(&database).unwrap(), before);
}

#[test]
fn damaged_record_checksum_fails_closed_and_does_not_admit_new_work() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    let retained = reserve(&mut journal, "retained");
    let conn = rusqlite::Connection::open(fixture.path().join("recovery.sqlite3")).unwrap();
    conn.execute("UPDATE records SET digest=?1", ["0".repeat(64)])
        .unwrap();
    assert!(journal.records().is_err());
    assert!(journal.ready(&retained).is_err());
    let authority = authority();
    assert!(journal
        .reserve(binding(&authority, &prepared(&authority)))
        .is_err());
    drop(conn);
    drop(journal);
    assert!(Journal::open(&fixture.path()).is_err());
}

#[cfg(unix)]
#[test]
fn directory_or_database_replacement_invalidates_the_original_connection() {
    let fixture = Fixture::new();
    let journal = fixture.create();
    let database = fixture.path().join("recovery.sqlite3");
    std::fs::copy(&database, fixture.root.join("copy.sqlite3")).unwrap();
    std::fs::rename(&database, fixture.root.join("original.sqlite3")).unwrap();
    std::fs::rename(fixture.root.join("copy.sqlite3"), &database).unwrap();
    assert!(journal.records().is_err());
}

#[test]
fn max_records_never_evicts_original_unknowns() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    let first = reserve(&mut journal, "first");
    for index in 1..128 {
        reserve(&mut journal, &format!("target-{index}"));
    }
    let authority = authority();
    assert!(matches!(
        journal.reserve(binding(&authority, &prepared(&authority))),
        Err(Error::Capacity)
    ));
    assert_eq!(journal.records().unwrap().len(), 128);
    assert!(journal.current(&first).is_ok());
}

#[test]
fn edited_destination_or_alias_cannot_hide_an_unresolved_target() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    let record = reserve(&mut journal, "original");
    let authority = record.binding.authority.clone();
    let prepared = crate::ssh::files::native_save::contracts::operation::Prepared::new(
        &authority,
        vec!["original".into()],
        crate::ssh::files::native_save::contracts::operation::Baseline::Absent,
        "new".into(),
    )
    .unwrap();
    let mut alias = binding(&authority, &prepared);
    alias.destination.address = format!("{}@another-alias.invalid:22", authority.context.account);
    alias.destination.host_id = "different-saved-host".into();
    assert!(matches!(journal.reserve(alias), Err(Error::Occupied)));
    let mut edited = record.binding.clone();
    edited.operation_id = uuid::Uuid::new_v4().to_string();
    edited.authority.context.account = "changed-account".into();
    edited.destination.address = "changed-account@test.invalid:22".into();
    edited.intent.binding_sha256 = edited.authority.binding();
    edited.intent_sha256 = edited.intent.digest();
    assert!(edited.valid());
    assert!(matches!(journal.reserve(edited), Err(Error::Occupied)));
}

#[test]
fn cleanup_also_respects_four_potentially_active_workers() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    let record = reserve(&mut journal, "settled");
    let ready = journal.ready(&record).unwrap();
    let dispatched = journal.dispatch(&ready).unwrap().0;
    let terminal = journal
        .observe(&dispatched, receipt(&dispatched, "succeeded", 3))
        .unwrap();
    for name in ["one", "two", "three", "four"] {
        let record = reserve(&mut journal, name);
        let ready = journal.ready(&record).unwrap();
        journal.dispatch(&ready).unwrap();
    }
    assert!(matches!(
        journal.release(&terminal, true),
        Err(Error::Capacity)
    ));
    assert!(journal.current(&terminal).is_ok());
}

#[test]
fn full_checkpoint_failure_never_returns_a_dispatch_permit() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    let record = reserve(&mut journal, "read-only");
    let ready = journal.ready(&record).unwrap();
    // Force SQLite to reject the write rather than simulating successful persistence.
    journal
        .conn
        .pragma_update(None, "query_only", true)
        .unwrap();
    assert!(journal.dispatch(&ready).is_err());
    assert!(journal.current(&ready).is_ok());
}

#[cfg(unix)]
#[test]
fn ancestor_alias_is_resolved_but_the_selected_directory_link_is_rejected() {
    let fixture = Fixture::new();
    std::os::unix::fs::symlink(&fixture.root, fixture.root.join("ancestor-alias")).unwrap();
    let alias = fixture.root.join("ancestor-alias/native-file-saves");
    let journal = Journal::create(&alias).unwrap();
    assert!(journal.records().unwrap().is_empty());
    drop(journal);
    assert!(Journal::open(&alias).is_ok());
    let selected = fixture.root.join("selected-link");
    std::os::unix::fs::symlink(fixture.path(), &selected).unwrap();
    assert!(Journal::open(&selected).is_err());
    assert!(Journal::create(&selected).is_err());
}
