use super::*;
use std::{
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct Worker(Child);
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn actual_process_death_preserves_dispatch_and_rolls_back_partial_transitions() {
    for phase in [
        "prepared",
        "dispatched",
        "uncommitted-dispatch",
        "uncommitted-upgrade",
        "recoverable",
        "uncommitted-resume",
        "expanded",
        "uncommitted-expansion",
    ] {
        let fixture = Fixture::new();
        let signal = fixture.root.join("checkpoint.json");
        let mut child=Worker(Command::new(std::env::current_exe().unwrap())
            .args(["--exact","ssh::files::native_save::journal::admission::tests::crash::legacy_checkpoint_child","--ignored"])
            .env("TUNNELDE_TEST_LEGACY_JOURNAL_ROOT",&fixture.root).env("TUNNELDE_TEST_LEGACY_JOURNAL_PHASE",phase)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(20);
        while !signal.is_file() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "child stopped: {phase}"
            );
            assert!(Instant::now() < deadline, "child timed out: {phase}");
            std::thread::sleep(Duration::from_millis(10));
        }
        let bytes = std::fs::read(&signal).unwrap();
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let mut journal = Journal::open(&fixture.path()).unwrap();
        if phase == "uncommitted-upgrade" {
            assert_eq!(
                journal
                    .conn
                    .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            journal.enable_admission().unwrap();
            assert!(journal.legacy_claims().unwrap().is_empty());
            continue;
        }
        let expected: Claim = serde_json::from_slice(&bytes).unwrap();
        assert!(journal.legacy_claims().unwrap() == [expected.clone()]);
        assert!(matches!(
            native(&mut journal, "blocked/child"),
            Err(Error::Occupied)
        ));
        if matches!(phase, "dispatched" | "expanded" | "uncommitted-expansion") {
            assert!(journal.retire_unsent_legacy(&expected).is_err());
            assert!(journal.dispatch_legacy(&expected).is_err());
            assert_eq!(
                matches!(
                    native(&mut journal, ".expanded-stage"),
                    Err(Error::Occupied)
                ),
                phase == "expanded",
            );
        } else if matches!(phase, "recoverable" | "uncommitted-resume") {
            assert!(expected.phase == Phase::Recoverable);
            assert!(journal.retire_unsent_legacy(&expected).is_err());
            let continued = journal.dispatch_legacy(&expected).unwrap();
            journal.settle_legacy(continued).unwrap();
            native(&mut journal, "blocked/child").unwrap();
        } else {
            journal.retire_unsent_legacy(&expected).unwrap();
            native(&mut journal, "blocked/child").unwrap();
        }
    }
}

#[test]
#[ignore = "isolated crash child, explicitly invoked and killed by parent"]
fn legacy_checkpoint_child() {
    let root =
        std::path::PathBuf::from(std::env::var_os("TUNNELDE_TEST_LEGACY_JOURNAL_ROOT").unwrap());
    assert!(root.is_absolute());
    assert!(root
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("tunnelde-legacy-journal-"));
    let phase = std::env::var("TUNNELDE_TEST_LEGACY_JOURNAL_PHASE").unwrap();
    assert!([
        "prepared",
        "dispatched",
        "uncommitted-dispatch",
        "uncommitted-upgrade",
        "recoverable",
        "uncommitted-resume",
        "expanded",
        "uncommitted-expansion"
    ]
    .contains(&phase.as_str()));
    let mut journal = Journal::create(&root.join("native-file-saves")).unwrap();
    let signal = if phase == "uncommitted-upgrade" {
        journal.conn.execute_batch("BEGIN IMMEDIATE;CREATE TABLE legacy_claims(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);PRAGMA user_version=2;").unwrap();
        b"{}".to_vec()
    } else {
        journal.enable_admission().unwrap();
        let mut claim = journal
            .reserve_legacy(
                if matches!(phase.as_str(), "expanded" | "uncommitted-expansion") {
                    Kind::Transfer
                } else if matches!(phase.as_str(), "recoverable" | "uncommitted-resume") {
                    Kind::Editor
                } else {
                    Kind::Delete
                },
                owner(),
                vec![scope("/workspace/blocked")],
            )
            .unwrap();
        if phase == "dispatched" {
            claim = journal.dispatch_legacy(&claim).unwrap().claim().clone();
        }
        if matches!(phase.as_str(), "expanded" | "uncommitted-expansion") {
            claim = journal.dispatch_legacy(&claim).unwrap().claim().clone();
            if phase == "expanded" {
                claim = journal
                    .extend_transfer(&claim, vec![scope("/workspace/.expanded-stage")])
                    .unwrap();
            } else {
                let mut next = claim.clone();
                next.revision += 2;
                next.scopes[0]
                    .paths
                    .push("/workspace/.expanded-stage".into());
                let (bytes, digest) = persistence::encode(&next).unwrap();
                journal.conn.execute_batch("BEGIN IMMEDIATE").unwrap();
                journal
                    .conn
                    .execute(
                        "UPDATE legacy_claims SET revision=?1,value=?2,digest=?3 WHERE id=?4",
                        rusqlite::params![next.revision as i64, bytes, digest, next.id],
                    )
                    .unwrap();
                journal.conn.cache_flush().unwrap();
            }
        }
        if matches!(phase.as_str(), "recoverable" | "uncommitted-resume") {
            let permit = journal.dispatch_legacy(&claim).unwrap();
            journal.park_editor_cleanup(permit).unwrap();
            claim = journal.legacy_claims().unwrap().remove(0);
            if phase == "uncommitted-resume" {
                journal
                    .conn
                    .execute_batch("BEGIN IMMEDIATE;UPDATE legacy_claims SET revision=999;")
                    .unwrap();
            }
        }
        if phase == "uncommitted-dispatch" {
            journal
                .conn
                .execute_batch("BEGIN IMMEDIATE;UPDATE legacy_claims SET revision=999;")
                .unwrap();
        }
        serde_json::to_vec(&claim).unwrap()
    };
    use std::io::Write;
    let mut file = std::fs::File::create(root.join("signal.tmp")).unwrap();
    file.write_all(&signal).unwrap();
    file.sync_all().unwrap();
    drop(file);
    std::fs::rename(root.join("signal.tmp"), root.join("checkpoint.json")).unwrap();
    std::thread::sleep(Duration::from_secs(60));
    panic!("parent did not kill child");
}
