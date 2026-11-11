use super::{contracts::*, *};
use crate::{
    error::AppError,
    storage::{
        self, config,
        layout::{Category, Paths},
        migration, MUTATIONS,
    },
};
use std::{collections::BTreeMap, path::PathBuf};

struct Fixture {
    _serial: std::sync::MutexGuard<'static, ()>,
    root: PathBuf,
    paths: Paths,
}
impl Fixture {
    fn new() -> Self {
        let serial = storage::PUBLIC_TESTS.lock().unwrap();
        let root =
            std::env::temp_dir().join(format!("tunnelde-recovery-api-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("home")).unwrap();
        let paths = Paths::new(root.join("home"), root.join("logs"), &BTreeMap::new(), None);
        Self {
            _serial: serial,
            root,
            paths,
        }
    }
    fn snapshot(&self) -> Snapshot {
        observe(&self.paths, Observe::default(), || Ok(()))
            .unwrap()
            .snapshot
            .unwrap()
    }
    fn schedule(&self) {
        let mut state = config::Config::default();
        migration::schedule(
            &self.paths,
            &mut state,
            vec![config::Change {
                category: Category::PluginData,
                target: self.root.join("target"),
                migrate: true,
            }],
        )
        .unwrap();
    }
    fn run(&self, action: Action) -> Snapshot {
        request(
            &self.paths,
            Request {
                revision: self.snapshot().revision,
                action,
            },
            || Ok(()),
            || Ok(()),
            |save| save(),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn metadata_is_bounded_conditional_and_does_not_probe_recorded_paths() {
    let f = Fixture::new();
    let initial = f.snapshot();
    assert!(initial.pending.is_none());
    assert!(!f.paths.home.join("storage.json").exists());
    assert!(observe(
        &f.paths,
        Observe {
            revision: Some(initial.revision)
        },
        || Ok(())
    )
    .unwrap()
    .snapshot
    .is_none());
    f.schedule();
    let mut state = config::load(&f.paths.home).unwrap();
    state.last_error = Some("private /secret/error".into());
    state
        .archives
        .insert(Category::Keys, f.root.join("does-not-exist"));
    state
        .previous
        .insert(Category::Logs, f.root.join("not-a-directory"));
    std::fs::write(f.root.join("not-a-directory"), b"not scanned").unwrap();
    config::save(&f.paths.home, &state).unwrap();
    let snapshot = f.snapshot();
    assert!(snapshot.has_error);
    assert_eq!(snapshot.recorded_copies.len(), 2);
    let wire = serde_json::to_string(&snapshot).unwrap();
    assert!(!wire.contains("secret"));
    assert!(!wire.contains(&state.pending.as_ref().unwrap().id));
    let before = snapshot.revision;
    state.pending.as_mut().unwrap().id = uuid::Uuid::new_v4().to_string();
    config::save(&f.paths.home, &state).unwrap();
    assert_ne!(f.snapshot().revision, before);
    for path in [PathBuf::from("relative"), f.root.join("x".repeat(4097))] {
        state.archives.insert(Category::Keys, path);
        config::save(&f.paths.home, &state).unwrap();
        assert!(observe(&f.paths, Observe::default(), || Ok(())).is_err());
    }
}

#[test]
fn deferred_retry_preserves_error_and_current_data_then_real_startup_applies() {
    let f = Fixture::new();
    f.schedule();
    std::fs::create_dir_all(f.paths.dir(Category::PluginData)).unwrap();
    std::fs::write(f.paths.dir(Category::PluginData).join("draft"), b"keep").unwrap();
    let mut state = config::load(&f.paths.home).unwrap();
    state.last_error = Some("prior failure".into());
    config::save(&f.paths.home, &state).unwrap();
    let pending = f.run(Action::Retry).pending.unwrap();
    assert_eq!(pending.action, Direction::Apply);
    assert!(pending.restart_requested);
    assert!(f.snapshot().has_error);
    assert!(!f.root.join("target").exists());
    let active = storage::initialize(f.paths.home.clone(), f.root.join("logs"), None).unwrap();
    assert_eq!(
        active.dir(Category::PluginData),
        std::fs::canonicalize(f.root.join("target")).unwrap()
    );
    assert_eq!(
        std::fs::read(active.dir(Category::PluginData).join("draft")).unwrap(),
        b"keep"
    );
    assert!(f.snapshot().pending.is_none());
    assert!(!f.snapshot().has_error);
}

#[test]
fn retry_after_cancel_never_reverses_direction_or_deletes_retained_copies() {
    let f = Fixture::new();
    f.schedule();
    let state = config::load(&f.paths.home).unwrap();
    let pending = state.pending.unwrap();
    let stage = migration::stage(&pending.changes[0], &pending.id).unwrap();
    std::fs::create_dir_all(&stage).unwrap();
    std::fs::write(stage.join(migration::MARKER), &pending.id).unwrap();
    std::fs::write(stage.join("partial"), b"retained").unwrap();
    f.run(Action::Cancel);
    let retry = f.run(Action::Retry);
    assert_eq!(retry.pending.unwrap().action, Direction::Cancel);
    assert!(!f.root.join("target").exists());
    let active = storage::initialize(f.paths.home.clone(), f.root.join("logs"), None).unwrap();
    assert_eq!(
        active.dir(Category::PluginData),
        f.paths.dir(Category::PluginData)
    );
    assert!(f.snapshot().pending.is_none());
    assert_eq!(std::fs::read(stage.join("partial")).unwrap(), b"retained");
    assert_eq!(
        f.snapshot().recorded_copies[0].path,
        stage.to_str().unwrap()
    );
}

#[test]
fn failed_startup_consumes_request_and_keeps_plan_error_and_foreign_files() {
    let f = Fixture::new();
    f.schedule();
    f.run(Action::Retry);
    std::fs::create_dir_all(f.root.join("target")).unwrap();
    std::fs::write(f.root.join("target/foreign"), b"keep").unwrap();
    storage::initialize(f.paths.home.clone(), f.root.join("logs"), None).unwrap();
    let snapshot = f.snapshot();
    assert!(snapshot.has_error);
    assert!(!snapshot.pending.unwrap().restart_requested);
    assert_eq!(
        std::fs::read(f.root.join("target/foreign")).unwrap(),
        b"keep"
    );
}

#[test]
fn stale_revision_revocation_cancellation_and_busy_writer_never_publish() {
    let f = Fixture::new();
    f.schedule();
    let initial = std::fs::read(f.paths.home.join("storage.json")).unwrap();
    for mode in 0..4 {
        let revision = if mode == 0 {
            "stale".into()
        } else {
            f.snapshot().revision
        };
        let result = request(
            &f.paths,
            Request {
                revision,
                action: Action::Cancel,
            },
            || Ok(()),
            || {
                if mode == 2 {
                    Err(AppError::validation("plugin.api.cancelled"))
                } else {
                    Ok(())
                }
            },
            |save| {
                if mode == 1 {
                    return Err(AppError::validation("pluginSecurity.revoked"));
                }
                if mode == 3 {
                    let _lock = MUTATIONS.lock().unwrap();
                    return save();
                }
                save()
            },
        );
        let expected = [
            "storage.recovery.conflict",
            "pluginSecurity.revoked",
            "plugin.api.cancelled",
            "storage.recovery.busy",
        ][mode];
        assert_eq!(result.err().unwrap().to_string(), expected);
        assert_eq!(
            std::fs::read(f.paths.home.join("storage.json")).unwrap(),
            initial
        );
        assert_eq!(std::fs::read_dir(&f.paths.home).unwrap().count(), 1);
    }
}

#[test]
fn final_cas_preserves_concurrent_changes_and_policy_is_outside_writer_lock() {
    let f = Fixture::new();
    f.schedule();
    let revision = f.snapshot().revision;
    let error = request(
        &f.paths,
        Request {
            revision,
            action: Action::Cancel,
        },
        || {
            outside_writer_lock();
            Ok(())
        },
        || Ok(()),
        |save| {
            outside_writer_lock();
            let mut state = config::load(&f.paths.home)?;
            state.last_error = Some("concurrent".into());
            config::save(&f.paths.home, &state)?;
            save()
        },
    )
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "storage.recovery.conflict");
    assert!(!f.snapshot().pending.unwrap().restart_requested);
}

fn outside_writer_lock() {
    let (send, receive) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _lock = MUTATIONS.lock().unwrap();
        send.send(()).unwrap();
    });
    receive
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("policy called while holding writer lock");
    worker.join().unwrap();
}

#[test]
fn requests_reject_extra_fields_null_revision_unknown_actions_and_no_plan() {
    for value in [
        serde_json::json!({"revision":null,"action":"retry"}),
        serde_json::json!({"revision":"r","action":"apply"}),
        serde_json::json!({"revision":"r","action":"cancel","path":"/"}),
        serde_json::json!({"revision":"\n","action":"retry"}),
    ] {
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
    let f = Fixture::new();
    assert_eq!(
        request(
            &f.paths,
            Request {
                revision: f.snapshot().revision,
                action: Action::Cancel
            },
            || Ok(()),
            || Ok(()),
            |save| save()
        )
        .err()
        .unwrap()
        .to_string(),
        "storage.recovery.noPendingPlan"
    );
}

#[test]
fn emit_host_storage_recovery_contract() {
    let f = Fixture::new();
    f.schedule();
    let initial = observe(&f.paths, Observe::default(), || Ok(())).unwrap();
    let idle = observe(
        &f.paths,
        Observe {
            revision: Some(initial.revision.clone()),
        },
        || Ok(()),
    )
    .unwrap();
    let request = serde_json::json!({"revision":initial.revision,"action":"cancel"});
    let scheduled = f.run(Action::Cancel);
    if let Some(path) = std::env::var_os("TUNNELDE_RECOVERY_CONTRACT_OUTPUT") {
        std::fs::write(path,serde_json::to_vec(&serde_json::json!({"initial":initial,"idle":idle,"request":request,"scheduled":RequestResult{version:1,outcome:"restartScheduled",snapshot:scheduled}})).unwrap()).unwrap();
    }
}
