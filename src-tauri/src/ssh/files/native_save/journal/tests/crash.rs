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
fn forced_process_exit_preserves_each_checkpoint_and_rolls_back_uncommitted_change() {
    for phase in [
        "reserved",
        "ready",
        "dispatched",
        "uncommitted",
        "provisioning",
    ] {
        let fixture = Fixture::new();
        let signal = fixture.root.join("checkpoint.json");
        let mut child = Worker(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "ssh::files::native_save::journal::tests::crash::checkpoint_child",
                    "--ignored",
                ])
                .env("TUNNELDE_TEST_NATIVE_JOURNAL_ROOT", &fixture.root)
                .env("TUNNELDE_TEST_NATIVE_JOURNAL_PHASE", phase)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(20);
        while !signal.is_file() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "checkpoint child stopped early: {phase}"
            );
            assert!(
                Instant::now() < deadline,
                "checkpoint child did not signal: {phase}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let expected: Record = serde_json::from_slice(&std::fs::read(&signal).unwrap()).unwrap();
        if phase == "provisioning" {
            // An independent process still owns the credential setup transaction.
            // A second connection cannot retire its reservation ahead of the writer.
            let mut contender = Journal::open(&fixture.path()).unwrap();
            assert!(contender.retire(&expected).is_err());
            assert!(contender.current(&expected).is_ok());
            assert!(fixture.root.join("qa-token").is_file());
        }
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let mut journal = Journal::open(&fixture.path()).unwrap();
        let current = journal.current(&expected).unwrap();
        assert!(current == expected);
        if phase == "dispatched" {
            assert!(journal.dispatch(&current).is_err());
        }
        // SQLite itself recovers the killed transaction. No application reset/repair occurs.
        assert_eq!(journal.records().unwrap().len(), 1);
        let authority = authority();
        let mut descendant = prepared(&authority);
        descendant.intent.target = vec!["original-target".into(), "child".into()];
        descendant.control.intent_sha256 = descendant.intent.digest();
        assert!(matches!(
            journal.reserve(binding(&authority, &descendant)),
            Err(Error::Occupied)
        ));
    }
}

#[test]
#[ignore = "isolated child process fixture, invoked by the force-exit parent test"]
fn checkpoint_child() {
    let root = PathBuf::from(std::env::var_os("TUNNELDE_TEST_NATIVE_JOURNAL_ROOT").unwrap());
    assert!(root.is_absolute());
    assert!(root
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("tunnelde-journal-"));
    let phase = std::env::var("TUNNELDE_TEST_NATIVE_JOURNAL_PHASE").unwrap();
    assert!(matches!(
        phase.as_str(),
        "reserved" | "ready" | "dispatched" | "uncommitted" | "provisioning"
    ));
    let mut journal = Journal::create(&root.join("native-file-saves")).unwrap();
    let mut record = reserve(&mut journal, "original-target");
    if phase == "ready" || phase == "dispatched" {
        record = journal.ready(&record).unwrap();
    }
    if phase == "dispatched" {
        record = journal.dispatch(&record).unwrap().0;
    }
    if phase == "uncommitted" {
        journal
            .conn
            .execute_batch("BEGIN IMMEDIATE; UPDATE records SET revision=999;")
            .unwrap();
    }
    if phase == "provisioning" {
        journal
            .provision(&record, || {
                let token = std::fs::File::create(root.join("qa-token")).unwrap();
                token.sync_all().unwrap();
                signal_checkpoint(&root, &record);
                std::thread::sleep(Duration::from_secs(60));
                panic!("parent did not terminate the provisioning child");
            })
            .unwrap();
        unreachable!();
    }
    signal_checkpoint(&root, &record);
    // Parent forcibly terminates this actual process while SQLite is still open.
    std::thread::sleep(Duration::from_secs(60));
    panic!("parent did not terminate the checkpoint child");
}

fn signal_checkpoint(root: &std::path::Path, record: &Record) {
    use std::io::Write;
    let mut signal = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("checkpoint.tmp"))
        .unwrap();
    signal
        .write_all(&serde_json::to_vec(record).unwrap())
        .unwrap();
    signal.sync_all().unwrap();
    drop(signal);
    std::fs::rename(root.join("checkpoint.tmp"), root.join("checkpoint.json")).unwrap();
}
