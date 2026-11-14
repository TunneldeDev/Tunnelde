use super::*;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let home =
            std::env::temp_dir().join(format!("tunnelde-storage-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&home).unwrap();
        Self(home)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
struct Worker(Child);
impl Worker {
    fn start(home: &Path, mode: &str) -> Self {
        Self(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "storage::ownership::tests::lease_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("TUNNELDE_STORAGE_LEASE_CHILD_HOME", home)
                .env("TUNNELDE_STORAGE_LEASE_CHILD_MODE", mode)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        )
    }
    fn ready(&mut self, home: &Path, expected: &str) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(value) = std::fs::read_to_string(home.join("child-ready")) {
                assert_eq!(value, expected);
                return;
            }
            assert!(
                self.0.try_wait().unwrap().is_none(),
                "Child exited before acquiring/rejecting the lease"
            );
            assert!(Instant::now() < deadline, "Storage lease child timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn finish(&mut self) {
        self.0.stdin.take().unwrap().write_all(b"q").unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            assert!(
                Instant::now() < deadline,
                "Storage lease child failed to exit"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
#[ignore = "subprocess fixture; exercised by the storage ownership tests"]
fn lease_child() {
    let Some(home) = std::env::var_os("TUNNELDE_STORAGE_LEASE_CHILD_HOME") else {
        return;
    };
    let mode = std::env::var("TUNNELDE_STORAGE_LEASE_CHILD_MODE").unwrap();
    let lease = Lease::acquire(Path::new(&home));
    let _lease = if mode == "busy" {
        assert!(lease.is_err_and(|error| error.kind() == io::ErrorKind::WouldBlock));
        std::fs::write(Path::new(&home).join("child-ready"), "busy").unwrap();
        None
    } else {
        let owned = lease.unwrap();
        std::fs::write(Path::new(&home).join("child-ready"), "owned").unwrap();
        Some(owned)
    };
    let mut input = [0];
    std::io::Read::read_exact(&mut std::io::stdin(), &mut input).unwrap();
}

#[test]
fn live_owner_excludes_another_process_without_touching_the_pending_plan() {
    let fixture = Fixture::new();
    let pending = br#"{"pending":{"id":"retained-review"}}"#;
    std::fs::write(fixture.0.join("storage.json"), pending).unwrap();
    let lease = Lease::acquire(&fixture.0).unwrap();
    let mut child = Worker::start(&fixture.0, "busy");
    child.ready(&fixture.0, "busy");
    child.finish();
    assert_eq!(
        std::fs::read(fixture.0.join("storage.json")).unwrap(),
        pending
    );
    drop(lease);
    assert!(fixture.0.join(SENTINEL).is_file());
    drop(Lease::acquire(&fixture.0).unwrap());
}

#[test]
fn process_exit_and_crash_release_handles_without_deleting_or_truncating_the_sentinel() {
    for crash in [false, true] {
        let fixture = Fixture::new();
        std::fs::write(fixture.0.join(SENTINEL), b"retained sentinel").unwrap();
        let mut child = Worker::start(&fixture.0, "hold");
        child.ready(&fixture.0, "owned");
        assert!(Lease::acquire(&fixture.0)
            .is_err_and(|error| error.kind() == io::ErrorKind::WouldBlock));
        if crash {
            child.0.kill().unwrap();
            child.0.wait().unwrap();
        } else {
            child.finish();
        }
        let lease = Lease::acquire(&fixture.0).unwrap();
        assert_eq!(
            std::fs::read(fixture.0.join(SENTINEL)).unwrap(),
            b"retained sentinel"
        );
        assert!(Lease::acquire(&fixture.0.join("."))
            .is_err_and(|error| error.kind() == io::ErrorKind::WouldBlock));
        drop(lease);
    }
}

#[test]
fn distinct_homes_are_independent_and_non_regular_sentinels_are_rejected() {
    let first = Fixture::new();
    let second = Fixture::new();
    let _first = Lease::acquire(&first.0).unwrap();
    let other = Lease::acquire(&second.0).unwrap();
    drop(other);
    std::fs::remove_file(second.0.join(SENTINEL)).unwrap();
    std::fs::create_dir(second.0.join(SENTINEL)).unwrap();
    assert!(Lease::acquire(&second.0).is_err());
}

#[test]
fn actual_startup_cannot_consume_a_migration_until_the_previous_process_exits() {
    use crate::storage::{
        config,
        layout::{Category, Paths},
        migration,
    };
    let fixture = Fixture::new();
    let home = fixture.0.join("home");
    std::fs::create_dir_all(home.join("plugin-data")).unwrap();
    std::fs::write(home.join("plugin-data/draft"), b"preserved data").unwrap();
    let paths = Paths::new(
        home.clone(),
        fixture.0.join("logs"),
        &Default::default(),
        None,
    );
    let target = fixture.0.join("target");
    let mut config = config::Config::default();
    migration::schedule(
        &paths,
        &mut config,
        vec![config::Change {
            category: Category::PluginData,
            target: target.clone(),
            migrate: true,
        }],
    )
    .unwrap();
    let before = std::fs::read(home.join("storage.json")).unwrap();
    let mut child = Worker::start(&home, "hold");
    child.ready(&home, "owned");
    assert!(initialize(home.clone(), fixture.0.join("logs"), None)
        .is_err_and(|error| error.to_string().contains("Another Tunnelde process")));
    assert_eq!(std::fs::read(home.join("storage.json")).unwrap(), before);
    assert!(!target.exists());
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    let (active, lease) = initialize(home.clone(), fixture.0.join("logs"), None).unwrap();
    assert_eq!(
        active.dir(Category::PluginData),
        target.canonicalize().unwrap()
    );
    assert_eq!(
        std::fs::read(target.join("draft")).unwrap(),
        b"preserved data"
    );
    assert_eq!(
        std::fs::read(home.join("plugin-data/draft")).unwrap(),
        b"preserved data"
    );
    assert!(config::load(&home).unwrap().pending.is_none());
    drop(lease);
}

#[cfg(unix)]
#[test]
fn final_symlinks_hardlinks_and_fifos_are_not_lease_authority() {
    let fixture = Fixture::new();
    let target = fixture.0.join("target");
    let sentinel = fixture.0.join(SENTINEL);
    std::fs::write(&target, b"foreign content").unwrap();
    std::os::unix::fs::symlink(&target, &sentinel).unwrap();
    assert!(Lease::acquire(&fixture.0).is_err());
    std::fs::remove_file(&sentinel).unwrap();
    std::fs::hard_link(&target, &sentinel).unwrap();
    assert!(Lease::acquire(&fixture.0).is_err());
    std::fs::remove_file(&sentinel).unwrap();
    // rustix does not expose mkfifoat on Apple platforms. Use the POSIX utility
    // for this fixture so macOS exercises the same nonblocking FIFO rejection.
    assert!(Command::new("mkfifo")
        .args(["-m", "600"])
        .arg(&sentinel)
        .status()
        .unwrap()
        .success());
    assert!(Lease::acquire(&fixture.0).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"foreign content");
}
