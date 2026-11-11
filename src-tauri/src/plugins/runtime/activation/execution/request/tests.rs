use super::*;
use crate::{db::Database, plugins::security};
use std::{path::PathBuf, sync::Arc, time::Duration};

struct Fixture {
    root: PathBuf,
    db: Database,
    manager: Arc<PluginsManager>,
    fingerprint: String,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("tunnelde-start-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("sample")).unwrap();
        std::fs::write(root.join("sample").join(crate::plugins::manifest::MANIFEST_FILE), r#"{"id":"sample","name":"Sample","version":"1.0.0","apiVersion":1,"runtime":"declarative","main":"view.json","views":[{"id":"main","title":"Sample"}]}"#).unwrap();
        std::fs::write(root.join("sample/view.json"), "{}").unwrap();
        crate::plugins::manifest::load(&root.join("sample")).unwrap();
        let manager = Arc::new(PluginsManager::load(root.clone()));
        let db = Database::in_memory().unwrap();
        let fingerprint = security::fingerprint(&root.join("sample")).unwrap();
        manager
            .security
            .set_permissions(&db, "sample", fingerprint.clone(), &[], Some(vec![]))
            .unwrap();
        Self {
            root,
            db,
            manager,
            fingerprint,
        }
    }

    fn permit(&self) -> StartPermit {
        self.manager
            .prepare_start("sample", &self.fingerprint)
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

#[tokio::test]
async fn package_admission_shares_readers_but_holds_mutations_until_engine_admission_finishes() {
    let fixture = Fixture::new();
    let permit = fixture.permit();
    let first = fixture
        .manager
        .admit_package("sample", &permit)
        .await
        .unwrap();
    let second = fixture
        .manager
        .admit_package("sample", &permit)
        .await
        .unwrap();
    let mut mutation = Box::pin(fixture.manager.mutations.write());
    assert!(futures_util::poll!(&mut mutation).is_pending());
    drop(first);
    assert!(futures_util::poll!(&mut mutation).is_pending());
    drop(second);
    let writer = mutation.await;
    let mut queued = Box::pin(fixture.manager.admit_package("sample", &permit));
    assert!(futures_util::poll!(&mut queued).is_pending());
    drop(writer);
    drop(queued.await.unwrap());
}

#[tokio::test]
async fn package_admission_cannot_borrow_a_new_grant_while_waiting_for_a_mutation() {
    let fixture = Fixture::new();
    let permit = fixture.permit();
    let writer = fixture.manager.mutations.write().await;
    let mut queued = Box::pin(fixture.manager.admit_package("sample", &permit));
    assert!(futures_util::poll!(&mut queued).is_pending());
    fixture.manager.security.retire_runtime("sample");
    assert_eq!(
        tokio::time::timeout(Duration::from_millis(200), &mut queued)
            .await
            .unwrap()
            .err()
            .unwrap()
            .to_string(),
        "pluginSecurity.changed"
    );
    drop(writer);
    assert!(fixture
        .manager
        .admit_package("sample", &fixture.permit())
        .await
        .is_ok());
}

#[tokio::test]
async fn stop_rejects_late_start_and_cancels_admission_waiting_for_instance() {
    let fixture = Fixture::new();
    let permit = fixture.permit();
    let instance = fixture.manager.instance("sample").await.unwrap();
    let held = instance.lock().await;
    let mut waiting = Box::pin(fixture.manager.admit_start("sample", &permit));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut waiting)
            .await
            .is_err()
    );
    fixture.manager.security.retire_runtime("sample");
    assert!(tokio::time::timeout(Duration::from_millis(200), waiting)
        .await
        .unwrap()
        .is_err());
    // Stop did not need the still-held instance mutex, and a delayed IPC cannot
    // mint a fresh generation from the still-approved package.
    assert!(fixture.manager.admitted_start("sample", &permit).is_err());
    drop(held);
    let replacement = fixture.permit();
    assert_ne!(replacement.stamp, permit.stamp);
    assert!(fixture
        .manager
        .admit_start("sample", &replacement)
        .await
        .is_ok());
}

#[tokio::test]
async fn unrelated_approval_does_not_cancel_admission_but_regrant_does() {
    let fixture = Fixture::new();
    let permit = fixture.permit();
    fixture
        .manager
        .security
        .set_permissions(&fixture.db, "other", "a".repeat(64), &[], Some(vec![]))
        .unwrap();
    assert!(fixture.manager.admit_start("sample", &permit).await.is_ok());
    fixture
        .manager
        .security
        .set_permissions(
            &fixture.db,
            "sample",
            fixture.fingerprint.clone(),
            &[],
            Some(vec![]),
        )
        .unwrap();
    assert!(fixture.manager.admitted_start("sample", &permit).is_err());
    assert!(fixture
        .manager
        .admitted_start("sample", &fixture.permit())
        .is_ok());
}

#[test]
fn admission_binds_content_identity_and_host_boot_without_starting_an_engine() {
    let fixture = Fixture::new();
    assert!(fixture.manager.prepare_start("sample", "wrong").is_err());
    assert!(fixture
        .manager
        .prepare_start("missing", &fixture.fingerprint)
        .is_err());
    let mut permit = fixture.permit();
    assert!(fixture.manager.admitted_start("other", &permit).is_err());
    permit.stamp = format!("{}:1", uuid::Uuid::new_v4());
    assert!(fixture.manager.admitted_start("sample", &permit).is_err());
    let snapshot = fixture.manager.snapshots.read().unwrap();
    assert_eq!(
        snapshot["sample"].status,
        crate::plugins::PluginStatus::Stopped
    );
}
