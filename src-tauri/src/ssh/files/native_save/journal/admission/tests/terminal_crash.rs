//! Kill a real process between the two real SQLite stores' terminal checkpoints.
use super::super::TransferOutcome;
use super::*;
use crate::ssh::files::{
    native_save::runtime::TransferTerminal, transfer_ownership::terminal::project,
};
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
fn actual_process_death_preserves_terminal_handoff_across_both_stores() {
    for phase in [
        "before-terminal",
        "uncommitted-terminal",
        "terminal",
        "app-uncommitted",
        "app-synced",
        "retire-uncommitted",
        "retired",
    ] {
        let fixture = Fixture::new();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact","ssh::files::native_save::journal::admission::tests::terminal_crash::transfer_terminal_checkpoint_child","--ignored"])
            .env("TUNNELDE_TEST_TRANSFER_TERMINAL_ROOT",&fixture.root)
            .env("TUNNELDE_TEST_TRANSFER_TERMINAL_PHASE",phase)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut worker = Worker(command.spawn().unwrap());
        let signal = fixture.root.join("checkpoint.json");
        let deadline = Instant::now() + Duration::from_secs(20);
        while !signal.is_file() {
            assert!(
                worker.0.try_wait().unwrap().is_none(),
                "child stopped: {phase}"
            );
            assert!(Instant::now() < deadline, "child timed out: {phase}");
            std::thread::sleep(Duration::from_millis(10));
        }
        let expected: Claim = serde_json::from_slice(&std::fs::read(&signal).unwrap()).unwrap();
        worker.0.kill().unwrap();
        worker.0.wait().unwrap();
        let mut journal = Journal::open(&fixture.path()).unwrap();
        let app = rusqlite::Connection::open(fixture.root.join("application.sqlite3")).unwrap();
        let projected: i64 = app
            .query_row(
                "SELECT count(*) FROM settings WHERE key LIKE 'transfer:%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        if matches!(phase, "before-terminal" | "uncommitted-terminal") {
            assert!(journal.legacy_claims().unwrap() == [expected.clone()]);
            assert!(expected.phase == Phase::Dispatched);
            assert!(journal.dispatch_legacy(&expected).is_err());
            assert!(journal.dispose_empty_transfer(&expected).is_err());
            assert_eq!(projected, 0);
            assert!(matches!(
                native(&mut journal, "output/child"),
                Err(Error::Occupied)
            ));
        } else {
            assert_eq!(
                projected,
                if matches!(phase, "terminal" | "app-uncommitted") {
                    0
                } else {
                    1
                },
                "{phase}"
            );
            if phase != "retired" {
                assert!(journal.legacy_claims().unwrap() == [expected.clone()]);
                assert!(expected.phase == Phase::Terminal);
                assert!(matches!(
                    native(&mut journal, "output/child"),
                    Err(Error::Occupied)
                ));
                let terminal = TransferTerminal::new(expected.clone()).unwrap();
                project(&app, &terminal).unwrap(); // idempotent local repair, no peer
                journal.retire_transfer_terminal(&expected).unwrap();
            }
            assert!(journal.legacy_claims().unwrap().is_empty());
            let row: String = app
                .query_row(
                    "SELECT value FROM settings WHERE key=?1",
                    [format!("transfer:{}", expected.owner.id)],
                    |row| row.get(0),
                )
                .unwrap();
            let row: crate::ssh::files::durable::DurableTransfer =
                serde_json::from_str(&row).unwrap();
            assert_eq!(row.status, "done");
            assert_eq!(row.transferred, 42);
            assert_eq!(row.to_path, "/workspace/output");
            native(&mut journal, "output/child").unwrap();
        }
    }
}

#[test]
#[ignore = "isolated two-store crash child, explicitly invoked and killed by parent"]
fn transfer_terminal_checkpoint_child() {
    let root =
        std::path::PathBuf::from(std::env::var_os("TUNNELDE_TEST_TRANSFER_TERMINAL_ROOT").unwrap());
    assert!(
        root.is_absolute()
            && root
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("tunnelde-legacy-journal-")
    );
    let phase = std::env::var("TUNNELDE_TEST_TRANSFER_TERMINAL_PHASE").unwrap();
    assert!([
        "before-terminal",
        "uncommitted-terminal",
        "terminal",
        "app-uncommitted",
        "app-synced",
        "retire-uncommitted",
        "retired"
    ]
    .contains(&phase.as_str()));
    let mut journal = Journal::create(&root.join("native-file-saves")).unwrap();
    journal.enable_admission().unwrap();
    let task_owner = owner();
    let claim = journal
        .reserve_transfer_task(
            task_owner.clone(),
            vec![task::root("/workspace/output")],
            task::task(&task_owner.id, "/workspace/output"),
        )
        .unwrap();
    let permit = journal.dispatch_legacy(&claim).unwrap();
    let dispatched = permit.claim().clone();
    let app = rusqlite::Connection::open(root.join("application.sqlite3")).unwrap();
    app.execute_batch("PRAGMA synchronous=NORMAL;CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);").unwrap();
    let expected = if phase == "before-terminal" {
        dispatched
    } else {
        let terminal = journal
            .complete_transfer(
                permit,
                TransferOutcome::Completed {
                    transferred: 42,
                    total: 42,
                },
            )
            .unwrap();
        if phase == "uncommitted-terminal" {
            let (previous, previous_digest) = persistence::encode(&dispatched).unwrap();
            journal
                .conn
                .execute(
                    "UPDATE legacy_claims SET revision=?1,value=?2,digest=?3 WHERE id=?4",
                    rusqlite::params![
                        dispatched.revision as i64,
                        previous,
                        previous_digest,
                        dispatched.id
                    ],
                )
                .unwrap();
            let (value, digest) = persistence::encode(&terminal).unwrap();
            journal.conn.execute_batch("BEGIN IMMEDIATE").unwrap();
            journal
                .conn
                .execute(
                    "UPDATE legacy_claims SET revision=?1,value=?2,digest=?3 WHERE id=?4",
                    rusqlite::params![terminal.revision as i64, value, digest, terminal.id],
                )
                .unwrap();
            journal.conn.cache_flush().unwrap();
            dispatched
        } else {
            if matches!(
                phase.as_str(),
                "app-uncommitted" | "app-synced" | "retire-uncommitted" | "retired"
            ) {
                project(&app, &TransferTerminal::new(terminal.clone()).unwrap()).unwrap();
            }
            if phase == "app-uncommitted" {
                let rows: Vec<(String, String, i64)> = app
                    .prepare("SELECT key,value,updated_at FROM settings")
                    .unwrap()
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                    .unwrap()
                    .collect::<std::result::Result<_, _>>()
                    .unwrap();
                app.execute_batch("DELETE FROM settings;BEGIN IMMEDIATE")
                    .unwrap();
                for (key, value, updated) in rows {
                    app.execute(
                        "INSERT INTO settings VALUES(?1,?2,?3)",
                        rusqlite::params![key, value, updated],
                    )
                    .unwrap();
                }
                app.cache_flush().unwrap();
            }
            if phase == "retire-uncommitted" {
                journal
                    .conn
                    .execute_batch("BEGIN IMMEDIATE;DELETE FROM legacy_claims")
                    .unwrap();
                journal.conn.cache_flush().unwrap();
            }
            if phase == "retired" {
                journal.retire_transfer_terminal(&terminal).unwrap();
            }
            terminal
        }
    };
    use std::io::Write;
    let mut signal = std::fs::File::create(root.join("signal.tmp")).unwrap();
    signal
        .write_all(&serde_json::to_vec(&expected).unwrap())
        .unwrap();
    signal.sync_all().unwrap();
    drop(signal);
    std::fs::rename(root.join("signal.tmp"), root.join("checkpoint.json")).unwrap();
    std::thread::sleep(Duration::from_secs(60));
    panic!("parent did not kill child");
}
