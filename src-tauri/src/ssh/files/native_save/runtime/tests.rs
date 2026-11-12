use super::super::{
    journal::{Journal, Stage},
    testing::*,
};
use super::*;

struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("tunnelde-runtime-qa-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self { root }
    }
    fn manager(&self) -> Manager {
        Manager::new(&self.root, &format!("qa.native.{}", uuid::Uuid::new_v4()))
    }
    fn journal(&self) -> Journal {
        Journal::create(&self.root.join("native-file-saves")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

#[tokio::test]
async fn construction_and_first_read_never_initialize_missing_authority() {
    let fixture = Fixture::new();
    let manager = fixture.manager();
    assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 0);
    assert!(manager.pending().await.is_empty());
    assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 0);
}
#[tokio::test]
async fn existing_records_reopen_without_touching_credentials_and_project_no_private_control() {
    let fixture = Fixture::new();
    let authority = authority();
    let prepared = prepared(&authority);
    let mut journal = fixture.journal();
    let record = journal.reserve(binding(&authority, &prepared)).unwrap();
    drop(journal);
    let manager = fixture.manager();
    let pending = manager.pending().await;
    assert_eq!(pending.len(), 1);
    let value = serde_json::to_value(&pending[0]).unwrap();
    assert_eq!(value["source"], "native");
    assert_eq!(value["action"], "discard");
    assert_eq!(value["error"], "editor.nativeUnsent");
    assert_eq!(value["running"], false);
    for forbidden in [
        "token",
        "authorityId",
        "owner",
        "generation",
        "intentSha256",
        "payloadSha256",
        "selection",
    ] {
        assert!(value.get(forbidden).is_none());
    }
    assert!(!value.to_string().contains(&prepared.control.token));
    let service = manager.existing().await.unwrap().unwrap();
    assert!(service.records().await.unwrap()[0] == record);
}
#[tokio::test]
async fn corruption_is_visible_as_a_recovery_task_and_not_recreated() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.root.join("native-file-saves")).unwrap();
    let database = fixture.root.join("native-file-saves/recovery.sqlite3");
    std::fs::write(&database, b"retained corrupt evidence").unwrap();
    let manager = fixture.manager();
    let pending = manager.pending().await;
    assert_eq!(pending[0].id, "native-store");
    assert_eq!(pending[0].action, Some("reload"));
    assert_eq!(
        pending[0].error.as_deref(),
        Some("editor.nativeJournalUnavailable")
    );
    assert_eq!(
        std::fs::read(database).unwrap(),
        b"retained corrupt evidence"
    );
}
#[tokio::test]
async fn failed_initial_open_cannot_be_hidden_by_later_removal() {
    let fixture = Fixture::new();
    let directory = fixture.root.join("native-file-saves");
    std::fs::create_dir(&directory).unwrap();
    let manager = fixture.manager();
    assert_eq!(manager.pending().await[0].id, "native-store");
    std::fs::remove_dir(directory).unwrap();
    assert_eq!(manager.pending().await[0].id, "native-store");
}
#[tokio::test]
async fn previously_loaded_authority_cannot_become_an_empty_first_run_after_invalidation() {
    let fixture = Fixture::new();
    drop(fixture.journal());
    let manager = fixture.manager();
    assert!(manager.pending().await.is_empty());
    #[cfg(unix)]
    std::fs::rename(
        fixture.root.join("native-file-saves"),
        fixture.root.join("kept-authority"),
    )
    .unwrap();
    // Windows keeps the SQLite file open without delete sharing; simulate removal
    // of its identity instead, rather than asserting an impossible directory rename.
    #[cfg(windows)]
    rusqlite::Connection::open(fixture.root.join("native-file-saves/recovery.sqlite3"))
        .unwrap()
        .execute("DELETE FROM metadata", [])
        .unwrap();
    assert_eq!(manager.pending().await[0].id, "native-store");
}
#[test]
fn historical_live_receipts_remain_attention_and_never_announce_current_execution() {
    let fixture = Fixture::new();
    let authority = authority();
    let prepared = prepared(&authority);
    let mut journal = fixture.journal();
    let record = journal.reserve(binding(&authority, &prepared)).unwrap();
    let ready = journal.ready(&record).unwrap();
    let mut record = journal.dispatch(&ready).unwrap().0;
    let mut receipt =
        response(&authority, Some(&prepared.control), "running", 3)["observation"].clone();
    receipt["live"] = true.into();
    record.observation = Some(serde_json::from_value(receipt).unwrap());
    assert!(record.stage == Stage::Dispatched);
    let pending = projection::record(&record);
    assert!(!pending.running);
    assert_eq!(pending.action, Some("query"));
    assert_eq!(
        pending.error.as_deref(),
        Some("editor.remoteOutcomeUnknown")
    );
}

#[test]
#[ignore = "explicit isolated desktop acceptance fixture; no remote IO or credential access"]
fn native_desktop_recovery_fixture() {
    let root = PathBuf::from(std::env::var_os("TUNNELDE_TEST_NATIVE_DESKTOP_ROOT").unwrap());
    assert!(root.is_absolute());
    let name = root.file_name().unwrap().to_str().unwrap();
    let suffix = name.strip_prefix("native-save-runtime-qa-").unwrap();
    assert!(crate::ssh::files::native_save::contracts::uuid(suffix));
    assert!(root.is_dir());
    let mut journal = Journal::create(&root.join("native-file-saves")).unwrap();
    let authority = authority();
    let prepared = prepared(&authority);
    let record = journal.reserve(binding(&authority, &prepared)).unwrap();
    std::fs::write(
        root.join("expected-operation"),
        &record.binding.operation_id,
    )
    .unwrap();
    // Retained for the actual desktop process to reopen and explicitly abandon.
    // The fixture is never dispatched and deliberately creates no OS credential.
}
