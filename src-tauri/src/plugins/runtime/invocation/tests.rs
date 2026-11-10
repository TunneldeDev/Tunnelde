use crate::{
    db::Database,
    plugins::{security::Lease, PluginStatus, PluginsManager},
};
use std::{path::PathBuf, sync::Arc, time::Duration};

struct Fixture {
    root: PathBuf,
    manager: Arc<PluginsManager>,
    _db: Database,
}

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("tunnelde-invocation-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("sample")).unwrap();
        std::fs::write(root.join("sample").join(crate::plugins::manifest::MANIFEST_FILE), r#"{"id":"sample","name":"Sample","version":"1.0.0","apiVersion":1,"runtime":"declarative","main":"view.json","views":[{"id":"main","title":"Sample"}]}"#).unwrap();
        std::fs::write(
            root.join("sample/view.json"),
            r#"{"views":{"main":{"title":"Sample","blocks":[]}}}"#,
        )
        .unwrap();
        let manager = Arc::new(PluginsManager::load(root.clone()));
        let db = Database::in_memory().unwrap();
        let fingerprint = crate::plugins::security::fingerprint(&root.join("sample")).unwrap();
        manager
            .security
            .set_permissions(&db, "sample", fingerprint, &[], Some(vec![]))
            .unwrap();
        Self {
            root,
            manager,
            _db: db,
        }
    }

    async fn activate(&self) -> (Lease, String) {
        let handle = self.manager.instance("sample").await.unwrap();
        let mut instance = handle.lock().await;
        let lease = self
            .manager
            .security
            .lease("sample", instance.fingerprint.clone(), vec![])
            .unwrap();
        let pending = self
            .manager
            .security
            .begin_runtime(&lease, &[], false)
            .unwrap();
        self.manager.security.native_ready(&lease).unwrap();
        pending.commit();
        let id = self.manager.security.lease_stamp(&lease);
        instance.status = PluginStatus::Running;
        instance.runtime_lease = Some(lease.clone());
        instance.runtime_id = Some(id.clone());
        self.manager.remember(&instance.info());
        (lease, id)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

#[tokio::test]
async fn delayed_ipc_cannot_borrow_replacement_even_with_identical_package() {
    let f = Fixture::new();
    let (old, id) = f.activate().await;
    assert_eq!(f.manager.invocation_lease("sample", &id).unwrap(), old);
    assert!(f.manager.invocation_lease("sample", "").is_err());
    assert!(f
        .manager
        .invocation_lease(
            "sample",
            &format!("{}:{}", uuid::Uuid::new_v4(), old.generation)
        )
        .is_err());
    f.manager.security.retire_runtime("sample");
    // The stored snapshot can still say running while async retirement settles.
    assert!(f.manager.invocation_lease("sample", &id).is_err());
    let (new, replacement) = f.activate().await;
    assert_ne!(id, replacement);
    assert_eq!(old.fingerprint, new.fingerprint);
    assert!(f.manager.run("sample", "test", None, &id).await.is_err());
    assert!(f.manager.admit_invocation("sample", &old).await.is_err());
    assert_eq!(
        f.manager
            .admit_invocation("sample", &new)
            .await
            .unwrap()
            .runtime_lease
            .as_ref(),
        Some(&new)
    );
}

#[tokio::test]
async fn stop_cancels_admission_without_waiting_for_held_instance_mutex() {
    let f = Fixture::new();
    let (lease, id) = f.activate().await;
    let handle = f.manager.instance("sample").await.unwrap();
    let held = handle.lock().await;
    let mut pending = Box::pin(f.manager.admit_invocation("sample", &lease));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut pending)
            .await
            .is_err()
    );
    f.manager.security.retire_runtime("sample");
    assert!(tokio::time::timeout(Duration::from_millis(200), pending)
        .await
        .unwrap()
        .is_err());
    assert!(f.manager.invocation_lease("sample", &id).is_err());
    drop(held);
    let (new, _) = f.activate().await;
    assert!(f.manager.admit_invocation("sample", &new).await.is_ok());
}

#[tokio::test]
async fn admission_checks_actual_files_and_exact_lease_owner() {
    let f = Fixture::new();
    let (lease, _) = f.activate().await;
    let foreign = Lease {
        id: "other".into(),
        ..lease.clone()
    };
    assert!(f
        .manager
        .admit_invocation("sample", &foreign)
        .await
        .is_err());
    std::fs::write(f.root.join("sample/view.json"), "changed").unwrap();
    assert!(f.manager.admit_invocation("sample", &lease).await.is_err());
    let handle = f.manager.instance("sample").await.unwrap();
    let mut instance = handle.lock().await;
    instance.status = PluginStatus::Stopped;
    assert!(instance.info().runtime_id.is_none());
    instance.status = PluginStatus::Failed;
    assert!(instance.info().runtime_id.is_none());
}

#[tokio::test]
async fn view_render_is_bound_before_waits_and_rejects_missing_or_replaced_runtime() {
    let f = Fixture::new();
    let (_, old) = f.activate().await;
    assert_eq!(
        f.manager
            .render_view("sample", "main", None, &old)
            .await
            .unwrap()["title"],
        "Sample"
    );
    assert!(f
        .manager
        .render_view("sample", "main", None, "")
        .await
        .is_err());
    let handle = f.manager.instance("sample").await.unwrap();
    let held = handle.lock().await;
    let mut pending = Box::pin(f.manager.render_view("sample", "main", None, &old));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut pending)
            .await
            .is_err()
    );
    f.manager.security.retire_runtime("sample");
    assert!(tokio::time::timeout(Duration::from_millis(200), pending)
        .await
        .unwrap()
        .is_err());
    drop(held);
    let (_, replacement) = f.activate().await;
    assert!(f
        .manager
        .render_view("sample", "main", None, &old)
        .await
        .is_err());
    assert!(f
        .manager
        .render_view("sample", "main", None, &replacement)
        .await
        .is_ok());
    std::fs::write(f.root.join("sample/view.json"), "{}").unwrap();
    assert!(f
        .manager
        .render_view("sample", "main", None, &replacement)
        .await
        .is_err());
}

#[tokio::test]
async fn render_waits_for_frontend_without_holding_the_instance_lock() {
    let f = Fixture::new();
    let (_, old) = f.activate().await;
    f.manager.security.retire_runtime("sample");
    let handle = f.manager.instance("sample").await.unwrap();
    let mut instance = handle.lock().await;
    let lease = f
        .manager
        .security
        .lease("sample", instance.fingerprint.clone(), vec![])
        .unwrap();
    let pending = f.manager.security.begin_runtime(&lease, &[], true).unwrap();
    f.manager.security.native_ready(&lease).unwrap();
    pending.commit();
    let id = f.manager.security.lease_stamp(&lease);
    assert_ne!(id, old);
    instance.runtime_lease = Some(lease.clone());
    instance.runtime_id = Some(id.clone());
    f.manager.remember(&instance.info());
    drop(instance);
    let mut render = Box::pin(f.manager.render_view("sample", "main", None, &id));
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut render)
        .await
        .is_err());
    let held = tokio::time::timeout(Duration::from_millis(200), handle.lock())
        .await
        .unwrap();
    f.manager
        .security
        .frontend_opened(&lease, "module")
        .unwrap();
    f.manager.security.frontend_ready(&lease, "module").unwrap();
    drop(held);
    assert_eq!(render.await.unwrap()["title"], "Sample");
}
