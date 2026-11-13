use super::super::admission::{Kind, Scope};
use super::*;
use crate::ssh::files::native_save::testing;
use std::path::PathBuf;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("tunnelde-setup-qa-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn directory(&self) -> PathBuf {
        self.0.join("recovery")
    }
    fn journal(&self) -> Journal {
        Journal::create(&self.directory()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn owner() -> Owner {
    Owner {
        id: uuid::Uuid::new_v4().to_string(),
        generation: uuid::Uuid::new_v4().to_string(),
    }
}
fn plan() -> Plan {
    testing::setup_plan()
}
fn scope(plan: &Plan, path: &str) -> Scope {
    Scope {
        destination: plan.destination.clone(),
        platform: "posix".into(),
        paths: vec![path.into()],
    }
}

#[test]
fn reads_do_not_upgrade_and_explicit_setup_upgrade_preserves_existing_authority() {
    let fixture = Fixture::new();
    let mut journal = fixture.journal();
    let authority = testing::authority();
    let prepared = testing::prepared(&authority);
    let native = journal
        .reserve(testing::binding(&authority, &prepared))
        .unwrap();
    let id = journal.id.clone();
    drop(journal);
    let mut journal = Journal::open(&fixture.directory()).unwrap();
    assert!(journal.setups().unwrap().is_empty());
    assert_eq!(journal.schema_version, 1);
    journal.enable_setups().unwrap();
    assert_eq!(journal.id, id);
    assert_eq!(journal.schema_version, 3);
    assert!(journal.records().unwrap() == vec![native]);
    assert!(journal.admission_enabled().unwrap());
    journal.enable_admission().unwrap();
    journal.enable_setups().unwrap();
    assert_eq!(journal.schema_version, 3);
    drop(journal);
    assert_eq!(
        Journal::open(&fixture.directory()).unwrap().schema_version,
        3
    );
}

#[test]
fn lost_install_reply_survives_restart_and_cannot_dispatch_or_discard_again() {
    let fixture = Fixture::new();
    let mut journal = fixture.journal();
    journal.enable_setups().unwrap();
    let reserved = journal.reserve_setup(owner(), plan()).unwrap();
    let dispatched = journal.dispatch_setup(&reserved).unwrap();
    assert!(journal.dispatch_setup(&reserved).is_err());
    let original = dispatched.record().clone();
    drop(dispatched);
    drop(journal);
    let mut journal = Journal::open(&fixture.directory()).unwrap();
    assert!(journal.setups().unwrap() == vec![original.clone()]);
    assert!(journal.discard_setup(&original).is_err());
    assert!(journal.dispatch_setup(&original).is_err());
    assert!(matches!(
        journal.reserve_setup(owner(), plan()),
        Err(Error::Occupied)
    ));
}

#[test]
fn two_connections_arbitrate_one_installer_and_stale_completion_cannot_replace_it() {
    let fixture = Fixture::new();
    let mut first = fixture.journal();
    first.enable_setups().unwrap();
    let mut second = Journal::open(&fixture.directory()).unwrap();
    let reserved = first.reserve_setup(owner(), plan()).unwrap();
    assert!(matches!(
        second.reserve_setup(owner(), plan()),
        Err(Error::Occupied)
    ));
    let permit = first.dispatch_setup(&reserved).unwrap();
    assert!(second.dispatch_setup(&reserved).is_err());
    assert!(second.discard_setup(&reserved).is_err());
    let ready = first.complete_setup(permit, testing::authority()).unwrap();
    assert!(ready.authority.is_some());
    assert!(second.setups().unwrap() == vec![ready]);
}

#[test]
fn changed_account_scope_platform_and_corrupt_setup_block_writes_without_repair() {
    for change in 0..3 {
        let fixture = Fixture::new();
        let mut journal = fixture.journal();
        journal.enable_setups().unwrap();
        let reserved = journal.reserve_setup(owner(), plan()).unwrap();
        let permit = journal.dispatch_setup(&reserved).unwrap();
        let mut foreign = testing::authority();
        match change {
            0 => foreign.context.account = "other".into(),
            1 => foreign.context.scope = "/other".into(),
            _ => {
                foreign.root.platform = "macos".into();
                foreign.storage_root.platform = "macos".into();
            }
        }
        assert!(journal.complete_setup(permit, foreign).is_err());
        assert!(journal.setups().unwrap()[0].stage == Stage::Dispatched);
    }
    let fixture = Fixture::new();
    let mut journal = fixture.journal();
    journal.enable_setups().unwrap();
    journal.reserve_setup(owner(), plan()).unwrap();
    journal
        .conn
        .execute("UPDATE native_setups SET digest='bad'", [])
        .unwrap();
    assert!(journal.records().is_err());
    assert!(journal.setups().is_err());
    assert!(journal
        .reserve_legacy(Kind::Create, owner(), vec![scope(&plan(), "/unrelated")])
        .is_err());
    drop(journal);
    let before = std::fs::read(fixture.directory().join("recovery.sqlite3")).unwrap();
    assert!(Journal::open(&fixture.directory()).is_err());
    assert_eq!(
        before,
        std::fs::read(fixture.directory().join("recovery.sqlite3")).unwrap()
    );
}

#[test]
fn installation_paths_share_legacy_and_native_admission_but_document_scope_stays_writable() {
    let fixture = Fixture::new();
    let mut journal = fixture.journal();
    journal.enable_setups().unwrap();
    let selected = plan();
    let legacy = journal
        .reserve_legacy(
            Kind::Delete,
            owner(),
            vec![scope(&selected, &selected.install_directory)],
        )
        .unwrap();
    assert!(matches!(
        journal.reserve_setup(owner(), selected.clone()),
        Err(Error::Occupied)
    ));
    journal.retire_unsent_legacy(&legacy).unwrap();
    let setup = journal.reserve_setup(owner(), selected.clone()).unwrap();
    for path in [
        &selected.install_directory,
        &selected.selection.directory,
        "/workspace",
    ] {
        assert!(matches!(
            journal.reserve_legacy(Kind::Delete, owner(), vec![scope(&selected, path)]),
            Err(Error::Occupied)
        ));
    }
    let allowed = journal
        .reserve_legacy(
            Kind::Create,
            owner(),
            vec![scope(&selected, "/workspace/document.txt")],
        )
        .unwrap();
    journal.retire_unsent_legacy(&allowed).unwrap();
    let authority = testing::authority();
    let prepared = testing::prepared(&authority);
    journal
        .reserve(testing::binding(&authority, &prepared))
        .unwrap();
    let mut private = testing::prepared(&authority);
    private.intent.target = vec![".tunnelde".into(), "native-saves".into(), "state".into()];
    private.control.intent_sha256 = private.intent.digest();
    assert!(matches!(
        journal.reserve(testing::binding(&authority, &private)),
        Err(Error::Occupied)
    ));
    journal.discard_setup(&setup).unwrap();
    journal.reserve_setup(owner(), selected).unwrap();
}

#[test]
fn alias_host_and_windows_spelling_cannot_evade_installation_exclusion() {
    let original = plan();
    let mut aliased = scope(&original, &original.selection.directory);
    aliased.destination.host_id = "other-id".into();
    aliased.destination.address = "user@alias:22".into();
    assert!(original.conflicts(&[aliased]));
    let mut windows = original.clone();
    windows.package.platform = "windows-x86_64".into();
    windows.context.scope = "C:/workspace".into();
    windows.install_directory = "C:/Users/user/Tunnelde/helpers".into();
    windows.selection.executable = "C:/Users/user/Tunnelde/helpers/agent.exe".into();
    windows.selection.directory = "C:/workspace/.tunnelde/saves".into();
    assert!(windows.valid());
    assert!(windows.protects(r"c:\USERS\USER\Tunnelde\helpers\agent.exe"));
    assert!(windows.protects("/C:/workspace/.tunnelde/saves/state"));
    assert!(!windows.protects("D:/workspace"));
    windows.selection.executable = "D:/elsewhere/agent.exe".into();
    assert!(!windows.valid());
}

#[test]
fn bounded_retention_never_evicts_unknown_installations() {
    let fixture = Fixture::new();
    let mut journal = fixture.journal();
    journal.enable_setups().unwrap();
    for index in 0..32 {
        let mut selected = plan();
        selected.install_directory = format!("/qa/helpers/{index}");
        selected.selection.executable = format!("/qa/helpers/{index}/agent");
        selected.selection.directory = format!("/workspace/.tunnelde/state/{index}");
        let reserved = journal.reserve_setup(owner(), selected).unwrap();
        drop(journal.dispatch_setup(&reserved).unwrap());
    }
    assert!(matches!(
        journal.reserve_setup(owner(), plan()),
        Err(Error::Capacity)
    ));
    drop(journal);
    assert_eq!(
        Journal::open(&fixture.directory())
            .unwrap()
            .setups()
            .unwrap()
            .len(),
        32
    );
}

#[test]
fn partial_schema_downgrade_and_oversized_rows_remain_unavailable() {
    for corrupt in 0..3 {
        let fixture = Fixture::new();
        let mut journal = fixture.journal();
        journal.enable_setups().unwrap();
        journal.reserve_setup(owner(), plan()).unwrap();
        match corrupt {
            0 => journal
                .conn
                .execute_batch("PRAGMA user_version=2;")
                .unwrap(),
            1 => journal
                .conn
                .execute_batch("DROP TABLE native_setups;")
                .unwrap(),
            _ => {
                journal
                    .conn
                    .execute("UPDATE native_setups SET value=?1", ["x".repeat(65537)])
                    .unwrap();
            }
        }
        assert!(journal.enable_setups().is_err());
        drop(journal);
        assert!(Journal::open(&fixture.directory()).is_err());
    }
}

#[test]
fn actual_process_exit_retains_each_committed_boundary_and_rolls_back_partial_upgrade() {
    for boundary in ["reserved", "dispatched", "ready", "upgrade"] {
        let fixture = Fixture::new();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "ssh::files::native_save::journal::setup::tests::process_boundary_worker",
            ])
            .env("TUNNELDE_QA_SETUP_DIRECTORY", &fixture.0)
            .env("TUNNELDE_QA_SETUP_BOUNDARY", boundary)
            .output()
            .unwrap();
        assert_eq!(
            status.status.code(),
            Some(74),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        let journal = Journal::open(&fixture.directory()).unwrap();
        if boundary == "upgrade" {
            assert_eq!(journal.schema_version, 2);
            assert!(journal.setups().unwrap().is_empty());
        } else {
            let setups = journal.setups().unwrap();
            assert_eq!(setups.len(), 1);
            assert!(
                setups[0].stage
                    == match boundary {
                        "reserved" => Stage::Reserved,
                        "dispatched" => Stage::Dispatched,
                        _ => Stage::Ready,
                    }
            );
        }
    }
}

#[test]
#[ignore = "subprocess fixture invoked by actual_process_exit_retains_each_committed_boundary_and_rolls_back_partial_upgrade"]
fn process_boundary_worker() {
    let root = PathBuf::from(std::env::var_os("TUNNELDE_QA_SETUP_DIRECTORY").unwrap());
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("tunnelde-setup-qa-"));
    let boundary = std::env::var("TUNNELDE_QA_SETUP_BOUNDARY").unwrap();
    let mut journal = Journal::create(&root.join("recovery")).unwrap();
    if boundary == "upgrade" {
        journal.enable_admission().unwrap();
        journal.conn.execute_batch("BEGIN IMMEDIATE; CREATE TABLE native_setups(id TEXT PRIMARY KEY, revision INTEGER NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL); PRAGMA user_version=3;").unwrap();
    } else {
        journal.enable_setups().unwrap();
        let reserved = journal.reserve_setup(owner(), plan()).unwrap();
        if boundary != "reserved" {
            let permit = journal.dispatch_setup(&reserved).unwrap();
            if boundary == "ready" {
                journal
                    .complete_setup(permit, testing::authority())
                    .unwrap();
            }
        }
    }
    // Simulate abrupt process loss: do not run SQLite/worker destructors.
    std::process::exit(74);
}
