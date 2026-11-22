use super::*;
use crate::{db::Database, plugins::PluginsManager, services::operations::Cancellation};
use std::{path::PathBuf, sync::Arc, time::Duration};

struct Fixture {
    root: PathBuf,
    plugins: Arc<PluginsManager>,
    db: Database,
    lease: Lease,
    params: Value,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("tunnelde-field-admission-{}", uuid::Uuid::new_v4()));
        let package = root.join("fields");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("tunnelde-plugin.json"),
            serde_json::to_vec(&json!({
                "id":"fields", "name":"Fields", "version":"1.0.0", "apiVersion":1,
                "main":"main.js", "permissions":["hosts.read","hosts.write"],
                "hostFields":{"version":1,"fields":[{"id":"owner","label":"Owner","type":"text"}]}
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(package.join("main.js"), "").unwrap();
        let plugins = Arc::new(PluginsManager::load(root.clone()));
        let info = plugins
            .snapshots
            .read()
            .unwrap()
            .get("fields")
            .unwrap()
            .clone();
        let db = Database::in_memory().unwrap();
        db.with(|conn| {
            conn.execute("INSERT INTO hosts(id,name,host,created_at,updated_at) VALUES('target','Target','127.0.0.1',0,0)", [])?;
            Ok(())
        }).unwrap();
        plugins
            .security
            .set_permissions(
                &db,
                "fields",
                info.fingerprint.clone(),
                &info.permissions,
                Some(info.permissions.clone()),
            )
            .unwrap();
        let lease = plugins
            .security
            .lease("fields", info.fingerprint, info.permissions)
            .unwrap();
        let schema = plugins
            .with_host_fields("fields", None, |schema| Ok(schema.clone()))
            .unwrap();
        let params = json!({"hostId":"target","schemaDigest":schema.digest().unwrap(),"expectedRevision":0,"values":{"owner":"Alice"}});
        Self {
            root,
            plugins,
            db,
            lease,
            params,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

struct Held {
    release: Option<std::sync::mpsc::Sender<()>>,
    owner: Option<std::thread::JoinHandle<()>>,
}
impl Held {
    async fn new(db: Database) -> Self {
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let owner = std::thread::spawn(move || {
            db.with(|_| {
                entered.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(8)).unwrap();
                Ok(())
            })
            .unwrap()
        });
        ready.await.unwrap();
        Self {
            release: Some(release),
            owner: Some(owner),
        }
    }
}
impl Drop for Held {
    fn drop(&mut self) {
        let _ = self.release.take().unwrap().send(());
        self.owner.take().unwrap().join().unwrap();
    }
}

#[tokio::test]
async fn host_field_wait_rechecks_package_before_db_unlock_without_late_write() {
    let fixture = Fixture::new();
    let held = Held::new(fixture.db.clone()).await;
    let (plugins, db, lease, params) = (
        fixture.plugins.clone(),
        fixture.db.clone(),
        fixture.lease.clone(),
        fixture.params.clone(),
    );
    let (entered, ready) = tokio::sync::oneshot::channel();
    let writer = tokio::spawn(async move {
        worker::run(move |cancel| {
            entered.send(()).unwrap();
            request(
                &plugins,
                &db,
                &lease,
                "hosts.setFields",
                params,
                cancel,
                None,
                None,
            )
        })
        .await
    });
    ready.await.unwrap();
    // The installed-package metadata lock must not be retained behind DB wait.
    fixture
        .plugins
        .snapshots
        .write()
        .unwrap()
        .get_mut("fields")
        .unwrap()
        .fingerprint = "b".repeat(64);
    let error = tokio::time::timeout(Duration::from_secs(1), writer)
        .await
        .unwrap()
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "pluginSecurity.changed");
    drop(held);
    fixture
        .db
        .with(|conn| {
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM host_plugin_fields", [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn host_field_wait_rechecks_revocation_and_preserves_original_cas() {
    let fixture = Fixture::new();
    let held = Held::new(fixture.db.clone()).await;
    let (plugins, db, lease, params) = (
        fixture.plugins.clone(),
        fixture.db.clone(),
        fixture.lease.clone(),
        fixture.params.clone(),
    );
    let (entered, ready) = tokio::sync::oneshot::channel();
    let writer = tokio::spawn(async move {
        worker::run(move |cancel| {
            entered.send(()).unwrap();
            request(
                &plugins,
                &db,
                &lease,
                "hosts.setFields",
                params,
                cancel,
                None,
                None,
            )
        })
        .await
    });
    ready.await.unwrap();
    fixture.plugins.security.remove_grant("fields");
    let error = tokio::time::timeout(Duration::from_secs(1), writer)
        .await
        .unwrap()
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "pluginSecurity.approvalRequired");
    drop(held);
    // Reapproval is a fresh lease, never borrowed by the old queued request.
    let info = fixture
        .plugins
        .snapshots
        .read()
        .unwrap()
        .get("fields")
        .unwrap()
        .clone();
    fixture
        .plugins
        .security
        .set_permissions(
            &fixture.db,
            "fields",
            info.fingerprint.clone(),
            &info.permissions,
            Some(info.permissions.clone()),
        )
        .unwrap();
    let lease = fixture
        .plugins
        .security
        .lease("fields", info.fingerprint, info.permissions)
        .unwrap();
    let (cancel, _owner) = Cancellation::for_test("cancelled");
    assert_eq!(
        request(
            &fixture.plugins,
            &fixture.db,
            &lease,
            "hosts.setFields",
            fixture.params.clone(),
            &cancel,
            None,
            None
        )
        .unwrap()
        .document
        .revision,
        1
    );
    let (cancel, _owner) = Cancellation::for_test("cancelled");
    assert_eq!(
        request(
            &fixture.plugins,
            &fixture.db,
            &lease,
            "hosts.setFields",
            fixture.params.clone(),
            &cancel,
            None,
            None
        )
        .err()
        .unwrap()
        .to_string(),
        "hostFields.conflict"
    );
}

struct RetiredOrigin;
impl crate::services::operations::Authority for RetiredOrigin {
    fn with_current(&self, _: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
        Err(AppError::validation("origin.expired"))
    }
}
#[test]
fn retired_native_fields_origin_cannot_commit_a_valid_original_revision() {
    let fixture = Fixture::new();
    let (cancel, _pending) = Cancellation::for_test("cancelled");
    let error = request(
        &fixture.plugins,
        &fixture.db,
        &fixture.lease,
        "hosts.setFields",
        fixture.params.clone(),
        &cancel,
        Some(&RetiredOrigin),
        None,
    )
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "origin.expired");
    let (cancel, _pending) = Cancellation::for_test("cancelled");
    let read = request(
        &fixture.plugins,
        &fixture.db,
        &fixture.lease,
        "hosts.getFields",
        json!({"hostId":"target"}),
        &cancel,
        None,
        None,
    )
    .unwrap();
    assert_eq!(read.document.revision, 0);
}

#[derive(Default)]
struct NativeOrigin {
    retired: std::sync::Mutex<bool>,
    attempts: std::sync::atomic::AtomicUsize,
}
impl crate::services::operations::Authority for NativeOrigin {
    fn with_current(&self, effect: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
        let retired = self.retired.lock().unwrap();
        if *retired {
            return Err(AppError::validation("origin.expired"));
        }
        self.attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        effect()
    }
}
#[tokio::test]
async fn native_fields_origin_can_retire_while_database_is_occupied() {
    let fixture = Fixture::new();
    let held = Held::new(fixture.db.clone()).await;
    let origin = Arc::new(NativeOrigin::default());
    let native = origin.clone();
    let (plugins, db, lease, params) = (
        fixture.plugins.clone(),
        fixture.db.clone(),
        fixture.lease.clone(),
        fixture.params.clone(),
    );
    let writer = tokio::spawn(async move {
        worker::run(move |cancel| {
            request(
                &plugins,
                &db,
                &lease,
                "hosts.setFields",
                params,
                cancel,
                Some(native.as_ref()),
                None,
            )
        })
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while origin.attempts.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    *origin.retired.lock().unwrap() = true;
    let error = tokio::time::timeout(Duration::from_secs(1), writer)
        .await
        .unwrap()
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "origin.expired");
    drop(held);
    let (cancel, _pending) = Cancellation::for_test("cancelled");
    let snapshot = request(
        &fixture.plugins,
        &fixture.db,
        &fixture.lease,
        "hosts.getFields",
        json!({"hostId":"target"}),
        &cancel,
        None,
        None,
    )
    .unwrap();
    assert_eq!(snapshot.document.revision, 0);
}
#[test]
fn native_fields_writes_preserve_plugin_schema_and_original_cas() {
    let fixture = Fixture::new();
    let origin = NativeOrigin::default();
    let (cancel, _pending) = Cancellation::for_test("cancelled");
    let snapshot = request(
        &fixture.plugins,
        &fixture.db,
        &fixture.lease,
        "hosts.setFields",
        fixture.params.clone(),
        &cancel,
        Some(&origin),
        None,
    )
    .unwrap();
    assert_eq!(snapshot.document.revision, 1);
    assert_eq!(snapshot.document.values.get("owner"), Some(&json!("Alice")));
    let (cancel, _pending) = Cancellation::for_test("cancelled");
    let error = request(
        &fixture.plugins,
        &fixture.db,
        &fixture.lease,
        "hosts.setFields",
        fixture.params.clone(),
        &cancel,
        Some(&origin),
        None,
    )
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "hostFields.conflict");
}

#[test]
fn native_origin_does_not_supply_a_missing_host_write_grant() {
    let fixture = Fixture::new();
    let declared = vec!["hosts.read".to_owned(), "hosts.write".to_owned()];
    fixture
        .plugins
        .security
        .set_permissions(
            &fixture.db,
            "fields",
            fixture.lease.fingerprint.clone(),
            &declared,
            Some(vec!["hosts.read".into()]),
        )
        .unwrap();
    let lease = fixture
        .plugins
        .security
        .lease("fields", fixture.lease.fingerprint.clone(), declared)
        .unwrap();
    let origin = NativeOrigin::default();
    let (cancel, _pending) = Cancellation::for_test("cancelled");
    let error = request(
        &fixture.plugins,
        &fixture.db,
        &lease,
        "hosts.setFields",
        fixture.params.clone(),
        &cancel,
        Some(&origin),
        None,
    )
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "pluginSecurity.permissionDenied");
    let (cancel, _pending) = Cancellation::for_test("cancelled");
    assert_eq!(
        request(
            &fixture.plugins,
            &fixture.db,
            &lease,
            "hosts.getFields",
            json!({"hostId":"target"}),
            &cancel,
            None,
            None
        )
        .unwrap()
        .document
        .revision,
        0
    );
}
