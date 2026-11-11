use super::{contracts::*, *};
use crate::{
    error::AppError,
    storage::{
        config,
        layout::{Category, Paths},
        migration, MUTATIONS,
    },
};
use std::{collections::BTreeMap, path::PathBuf};

struct Fixture {
    root: PathBuf,
    paths: Paths,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "tunnelde-location-contract-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("home")).unwrap();
        let paths = Paths::new(root.join("home"), root.join("logs"), &BTreeMap::new(), None);
        Self { root, paths }
    }
    fn snapshot(&self) -> Snapshot {
        observe(&self.paths, Observe::default(), || Ok(()))
            .unwrap()
            .snapshot
            .unwrap()
    }
    fn request(&self) -> Schedule {
        prepare_schedule(
            &self.paths,
            Schedule {
                revision: self.snapshot().revision,
                changes: vec![Change {
                    category: Category::Keys,
                    target: self.root.join("new-keys").to_str().unwrap().into(),
                    migrate: false,
                }],
            },
            || Ok(()),
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
fn observation_does_not_scan_or_expose_errors_and_private_pending_ids() {
    let f = Fixture::new();
    std::fs::write(f.paths.dir(Category::Keys), b"not a directory").unwrap();
    let initial = f.snapshot();
    assert_eq!(initial.locations.len(), 8);
    assert!(!f.paths.home.join("storage.json").exists());
    let idle = observe(
        &f.paths,
        Observe {
            revision: Some(initial.revision),
        },
        || Ok(()),
    )
    .unwrap();
    assert!(!idle.changed);
    assert!(idle.snapshot.is_none());
    let mut state = config::Config {
        last_error: Some("private error /secret".into()),
        ..Default::default()
    };
    config::save(&f.paths.home, &state).unwrap();
    let error = f.snapshot();
    assert!(error.recovery_required);
    assert!(!serde_json::to_string(&error)
        .unwrap()
        .contains("private error"));
    state.pending = Some(config::Pending {
        id: uuid::Uuid::new_v4().to_string(),
        changes: vec![config::Change {
            category: Category::Keys,
            target: f.root.join("target"),
            migrate: true,
        }],
    });
    config::save(&f.paths.home, &state).unwrap();
    let first = f.snapshot();
    assert!(!serde_json::to_string(&first)
        .unwrap()
        .contains(&state.pending.as_ref().unwrap().id));
    state.pending.as_mut().unwrap().id = uuid::Uuid::new_v4().to_string();
    config::save(&f.paths.home, &state).unwrap();
    assert_ne!(first.revision, f.snapshot().revision);
}

#[test]
fn schedule_and_unstarted_cancel_write_only_metadata() {
    let f = Fixture::new();
    let request = f.request();
    let target = request.changes[0].target.clone();
    let scheduled = schedule(&f.paths, request, || Ok(()), || Ok(()), |save| save()).unwrap();
    assert!(scheduled.pending.is_some());
    assert!(!PathBuf::from(&target).exists());
    let cancelled = cancel(
        &f.paths,
        Cancel {
            revision: scheduled.revision,
        },
        || Ok(()),
        || Ok(()),
        |save| save(),
    )
    .unwrap();
    assert!(cancelled.pending.is_none());
    assert!(!PathBuf::from(target).exists());
}

#[test]
fn fence_and_final_compare_reject_revocation_and_concurrent_native_changes() {
    let f = Fixture::new();
    let request = f.request();
    let error = schedule(
        &f.paths,
        request,
        || Ok(()),
        || Ok(()),
        |_| Err(AppError::validation("pluginSecurity.revoked")),
    )
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "pluginSecurity.revoked");
    assert!(f.snapshot().pending.is_none());
    let error = schedule(
        &f.paths,
        f.request(),
        || Ok(()),
        || Ok(()),
        |save| {
            config::save(
                &f.paths.home,
                &config::Config {
                    last_error: Some("concurrent native update".into()),
                    ..Default::default()
                },
            )?;
            save()
        },
    )
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "storage.locations.conflict");
    let state = config::load(&f.paths.home).unwrap();
    assert!(state.pending.is_none());
    assert_eq!(
        state.last_error.as_deref(),
        Some("concurrent native update")
    );
}

#[test]
fn recovering_plans_are_retained_without_deleting_artifacts() {
    let f = Fixture::new();
    schedule(&f.paths, f.request(), || Ok(()), || Ok(()), |save| save()).unwrap();
    let mut state = config::load(&f.paths.home).unwrap();
    let pending = state.pending.as_ref().unwrap();
    let stage = migration::stage(&pending.changes[0], &pending.id).unwrap();
    std::fs::create_dir_all(&stage).unwrap();
    std::fs::write(stage.join("keep"), b"retained").unwrap();
    assert!(f.snapshot().recovery_required);
    let error = cancel(
        &f.paths,
        Cancel {
            revision: f.snapshot().revision,
        },
        || Ok(()),
        || Ok(()),
        |save| save(),
    )
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "storage.locations.recoveryRequired");
    assert!(stage.join("keep").exists());
    state.last_error = Some("recovery interrupted".into());
    config::save(&f.paths.home, &state).unwrap();
    assert!(cancel(
        &f.paths,
        Cancel {
            revision: f.snapshot().revision
        },
        || Ok(()),
        || Ok(()),
        |save| save()
    )
    .is_err());
    assert!(config::load(&f.paths.home).unwrap().pending.is_some());
}

#[test]
fn policy_checks_and_commit_fence_never_run_under_metadata_lock() {
    let f = Fixture::new();
    let check = || {
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let lock = MUTATIONS.lock().unwrap();
            let _ = send.send(());
            drop(lock);
        });
        receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("policy called under metadata lock");
        Ok(())
    };
    observe(&f.paths, Observe::default(), check).unwrap();
    schedule(
        &f.paths,
        f.request(),
        check,
        || Ok(()),
        |save| {
            check()?;
            save()
        },
    )
    .unwrap();
}

#[test]
fn malformed_revisions_and_unknown_request_fields_are_rejected() {
    for value in [
        serde_json::json!({"revision":null}),
        serde_json::json!({"revision":""}),
        serde_json::json!({"revision":"a\n"}),
        serde_json::json!({"revision":"x".repeat(129)}),
        serde_json::json!({"path":"/"}),
    ] {
        assert!(serde_json::from_value::<Observe>(value).is_err());
    }
    assert!(serde_json::from_value::<Observe>(serde_json::json!({})).is_ok());
}

#[test]
fn cancelled_commit_cleans_staged_metadata_and_preserves_the_old_plan() {
    let f = Fixture::new();
    let error = schedule(
        &f.paths,
        f.request(),
        || Ok(()),
        || Err(AppError::validation("plugin.api.cancelled")),
        |save| save(),
    )
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "plugin.api.cancelled");
    assert!(f.snapshot().pending.is_none());
    assert!(!f.paths.home.join("storage.json").exists());
    assert_eq!(std::fs::read_dir(&f.paths.home).unwrap().count(), 0);
}

#[test]
fn oversized_pretty_configuration_never_replaces_a_readable_file() {
    let f = Fixture::new();
    let mut state = config::Config::default();
    state.archives.insert(Category::Cache, PathBuf::from("x"));
    let overhead = serde_json::to_vec_pretty(&state).unwrap().len() - 1;
    state.archives.insert(
        Category::Cache,
        PathBuf::from("x".repeat(128 * 1024 - overhead - 50)),
    );
    config::save(&f.paths.home, &state).unwrap();
    let before = std::fs::read(f.paths.home.join("storage.json")).unwrap();
    let error = schedule(
        &f.paths,
        f.request(),
        || Ok(()),
        || Ok(()),
        |_| panic!("oversized config reached the policy fence"),
    )
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "storage.invalidConfig");
    assert_eq!(
        std::fs::read(f.paths.home.join("storage.json")).unwrap(),
        before
    );
    assert!(config::load(&f.paths.home).unwrap().pending.is_none());
    assert_eq!(std::fs::read_dir(&f.paths.home).unwrap().count(), 1);
}

#[test]
fn emit_host_storage_location_contract() {
    let f = Fixture::new();
    let initial = observe(&f.paths, Observe::default(), || Ok(())).unwrap();
    let idle = observe(
        &f.paths,
        Observe {
            revision: Some(initial.revision.clone()),
        },
        || Ok(()),
    )
    .unwrap();
    let request = f.request();
    let schedule_request =
        serde_json::json!({"revision":request.revision,"changes":request.changes});
    let scheduled = schedule(&f.paths, request, || Ok(()), || Ok(()), |save| save()).unwrap();
    let cancel_request = serde_json::json!({"revision":scheduled.revision});
    let cancelled = cancel(
        &f.paths,
        Cancel {
            revision: scheduled.revision.clone(),
        },
        || Ok(()),
        || Ok(()),
        |save| save(),
    )
    .unwrap();
    if let Some(path) = std::env::var_os("TUNNELDE_LOCATION_CONTRACT_OUTPUT") {
        let fixture = serde_json::json!({"initial":initial,"idle":idle,"scheduleRequest":schedule_request,"cancelRequest":cancel_request,
            "scheduled":ChangeResult{version:1,outcome:"scheduled",snapshot:scheduled},
            "cancelled":ChangeResult{version:1,outcome:"cancelled",snapshot:cancelled}});
        std::fs::write(path, serde_json::to_vec(&fixture).unwrap()).unwrap();
    }
}
