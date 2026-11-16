use super::*;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

async fn hold_database(db: Arc<Database>) -> std::thread::JoinHandle<()> {
    let (entered, ready) = tokio::sync::oneshot::channel();
    let blocker = std::thread::spawn(move || {
        db.with(|_| {
            entered.send(()).unwrap();
            std::thread::sleep(Duration::from_secs(2));
            Ok(())
        })
        .unwrap();
    });
    ready.await.unwrap();
    blocker
}

#[tokio::test(flavor = "current_thread")]
async fn restricted_mode_database_wait_does_not_stall_runtime_heartbeat() {
    let db = Arc::new(Database::in_memory().unwrap());
    let security = Arc::new(PluginSecurity::default());
    security.initialize(&db, false).unwrap();
    let blocker = hold_database(db.clone()).await;
    let started = Instant::now();
    let heartbeat = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        started.elapsed()
    });
    // Same retained production operation as plugin_set_restricted.
    security
        .set_restricted_async((*db).clone(), true, false, ())
        .await
        .unwrap();
    let elapsed = heartbeat.await.unwrap();
    blocker.join().unwrap();
    assert!(security.snapshot(&[]).restricted);
    assert!(
        elapsed < Duration::from_secs(1),
        "restricted-mode persistence stalled runtime heartbeat for {elapsed:?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn authorized_database_wait_does_not_stall_unrelated_authorization() {
    let db = Arc::new(Database::in_memory().unwrap());
    let security = Arc::new(PluginSecurity::default());
    let digest = "a".repeat(64);
    let declared = vec!["settings.write".to_owned()];
    security
        .set_permissions(
            &db,
            "writer",
            digest.clone(),
            &declared,
            Some(declared.clone()),
        )
        .unwrap();
    let lease = security
        .lease("writer", digest.clone(), declared.clone())
        .unwrap();
    let blocker = hold_database(db.clone()).await;
    let worker_security = security.clone();
    let worker_db = db.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let writer = std::thread::spawn(move || {
        let entered = std::sync::Mutex::new(Some(entered));
        worker_security
            .with_authorized_database(
                &worker_db,
                &lease,
                &["settings.write"],
                || {
                    if let Some(entered) = entered.lock().unwrap().take() {
                        entered.send(()).unwrap();
                    }
                    Ok(())
                },
                |conn| {
                    let _: i64 = conn.query_row("SELECT 1", [], |row| row.get(0))?;
                    Ok(())
                },
            )
            .unwrap();
    });
    ready.await.unwrap();
    let started = Instant::now();
    let heartbeat = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        started.elapsed()
    });
    // Production authorization (also used by guard/dispatch), not a mock mutex.
    security
        .authorize("writer", &digest, &declared, Some("settings.write"), None)
        .unwrap();
    let elapsed = heartbeat.await.unwrap();
    blocker.join().unwrap();
    writer.join().unwrap();
    assert!(
        elapsed < Duration::from_secs(1),
        "authorized DB admission stalled unrelated authorization heartbeat for {elapsed:?}"
    );
}

fn fixture() -> (Arc<PluginSecurity>, Database, Lease) {
    let db = Database::in_memory().unwrap();
    let security = Arc::new(PluginSecurity::default());
    let declared = vec!["settings.write".to_owned()];
    let digest = "a".repeat(64);
    security
        .set_permissions(
            &db,
            "writer",
            digest.clone(),
            &declared,
            Some(declared.clone()),
        )
        .unwrap();
    let lease = security.lease("writer", digest, declared).unwrap();
    (security, db, lease)
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
async fn revoked_waiter_returns_before_db_unlock_and_never_executes_sql() {
    let (security, db, lease) = fixture();
    let held = Held::new(db.clone()).await;
    let worker = security.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let entered = std::sync::Mutex::new(Some(entered));
    let caller = tokio::task::spawn_blocking(move || {
        worker.with_authorized_database(
            &db,
            &lease,
            &["settings.write"],
            || {
                if let Some(entered) = entered.lock().unwrap().take() {
                    entered.send(()).unwrap();
                }
                Ok(())
            },
            |_| panic!("revoked request executed SQL"),
        )
    });
    ready.await.unwrap();
    security.remove_grant("writer");
    let result: AppResult<()> = tokio::time::timeout(Duration::from_secs(1), caller)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        result.unwrap_err().to_string(),
        "pluginSecurity.approvalRequired"
    );
    drop(held);
}

#[tokio::test]
async fn cancelled_admission_keeps_worker_owned_until_exit_without_late_sql() {
    use crate::services::operations::{Budget, Errors};
    let (security, db, lease) = fixture();
    let held = Held::new(db.clone()).await;
    let capacity = Arc::new(tokio::sync::Semaphore::new(1));
    let budget = Arc::new(Budget::with_capacity(
        capacity.clone(),
        Errors {
            domain: "test",
            busy: "busy",
            cancelled: "cancelled",
            failed: "failed",
        },
    ));
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (finished, done) = tokio::sync::oneshot::channel();
    let caller_budget = budget.clone();
    let caller = tokio::spawn(async move {
        caller_budget
            .blocking(move |cancel| {
                let entered = std::sync::Mutex::new(Some(entered));
                let result: AppResult<()> = security.with_authorized_database(
                    &db,
                    &lease,
                    &["settings.write"],
                    || {
                        if let Some(entered) = entered.lock().unwrap().take() {
                            entered.send(()).unwrap();
                        }
                        cancel.check()
                    },
                    |_| panic!("cancelled request executed SQL"),
                );
                finished
                    .send(result.as_ref().err().map(ToString::to_string))
                    .unwrap();
                result
            })
            .await
    });
    ready.await.unwrap();
    assert_eq!(
        budget
            .blocking::<()>(|_| panic!("over capacity"))
            .await
            .unwrap_err()
            .to_string(),
        "busy"
    );
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), done)
            .await
            .unwrap()
            .unwrap()
            .as_deref(),
        Some("cancelled")
    );
    // The retained worker exits on cancellation without waiting for the DB owner.
    drop(
        tokio::time::timeout(Duration::from_secs(1), capacity.acquire_owned())
            .await
            .unwrap()
            .unwrap(),
    );
    drop(held);
}

#[tokio::test]
async fn admitted_write_finishes_once_before_revocation_and_is_not_replayed() {
    let (security, db, lease) = fixture();
    let worker = security.clone();
    let worker_db = db.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let writer = tokio::task::spawn_blocking(move || {
        worker.with_authorized_database(
            &worker_db,
            &lease,
            &["settings.write"],
            || Ok(()),
            |conn| {
                entered.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                conn.execute(
                    "INSERT INTO settings(key,value,updated_at) VALUES('admitted','once',0)",
                    [],
                )?;
                Ok(())
            },
        )
    });
    ready.await.unwrap();
    let revoke = tokio::task::spawn_blocking(move || security.remove_grant("writer"));
    release.send(()).unwrap();
    writer.await.unwrap().unwrap();
    revoke.await.unwrap();
    db.with(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM settings WHERE key='admitted'",
                [],
                |r| r.get::<_, i64>(0)
            )?,
            1
        );
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn persistence_failure_restricts_and_revokes_but_never_grants_or_resumes() {
    let (security, db, _) = fixture();
    db.with(|conn| {
        conn.pragma_update(None, "query_only", true)?;
        Ok(())
    })
    .unwrap();
    assert!(security
        .permissions_async(
            db.clone(),
            super::super::PermissionChange {
                id: "writer".into(),
                digest: String::new(),
                declared: vec![],
                permissions: None,
            },
            |_| {}
        )
        .await
        .is_err());
    assert!(security
        .lease("writer", "a".repeat(64), vec!["settings.write".into()])
        .is_err());
    assert!(security
        .set_restricted_async(db.clone(), true, false, ())
        .await
        .is_err());
    assert!(security.snapshot(&[]).restricted);
    assert!(security
        .set_restricted_async(db.clone(), false, false, ())
        .await
        .is_err());
    assert!(security.snapshot(&[]).restricted);
    assert!(security
        .permissions_async(
            db.clone(),
            super::super::PermissionChange {
                id: "new".into(),
                digest: "b".repeat(64),
                declared: vec![],
                permissions: Some(vec![]),
            },
            |_| {}
        )
        .await
        .is_err());
    assert!(security
        .snapshot(&[("new".into(), "b".repeat(64), vec![])])
        .grants
        .is_empty());
}

#[tokio::test]
async fn cancelled_native_restriction_waiter_does_not_publish_late() {
    let (security, db, _) = fixture();
    let held = Held::new(db.clone()).await;
    let worker = security.clone();
    let caller = tokio::spawn(async move {
        worker
            .set_restricted_async(db.clone(), true, false, ())
            .await
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    drop(held);
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(!security.snapshot(&[]).restricted);
}

#[tokio::test(flavor = "current_thread")]
async fn cli_lock_is_immediate_while_database_is_occupied() {
    let (security, db, _) = fixture();
    let held = Held::new(db).await;
    let started = Instant::now();
    security.lock_cli();
    let snapshot = security.snapshot(&[]);
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(snapshot.restricted && snapshot.cli_locked);
    assert!(security
        .lease("writer", "a".repeat(64), vec!["settings.write".into()])
        .is_err());
    drop(held);
}

#[test]
fn database_releases_before_publication_without_splitting_revocation_boundary() {
    let (security, db, lease) = fixture();
    let (cancel, _owner) = crate::services::operations::Cancellation::for_test("cancelled");
    let value = security
        .with_authorized_database_then(
            &db,
            &lease,
            &["settings.write"],
            || cancel.check(),
            |conn| {
                cancel.commit()?;
                conn.execute(
                    "INSERT INTO settings(key,value,updated_at) VALUES('published','durable',0)",
                    [],
                )?;
                Ok("published")
            },
            |value| {
                assert!(
                    security.inner.try_lock().is_err(),
                    "revocation must remain fenced"
                );
                assert_eq!(
                    db.try_with(|conn| {
                        Ok(conn.query_row(
                            "SELECT value FROM settings WHERE key='published'",
                            [],
                            |r| r.get::<_, String>(0),
                        )?)
                    })?
                    .as_deref(),
                    Some("durable")
                );
                Ok(value)
            },
        )
        .unwrap();
    assert_eq!(value, "published");
}

#[test]
fn poisoned_database_still_closes_execution_and_does_not_approve() {
    let (security, db, _) = fixture();
    let poisoned = db.clone();
    assert!(std::thread::spawn(move || {
        let _ = poisoned.with::<()>(|_| panic!("controlled DB poison"));
    })
    .join()
    .is_err());
    assert!(security.set_restricted(&db, true, false).is_err());
    assert!(security.snapshot(&[]).restricted);
    assert!(security
        .set_permissions(&db, "writer", String::new(), &[], None)
        .is_err());
    assert!(security
        .snapshot(&[(
            "writer".into(),
            "a".repeat(64),
            vec!["settings.write".into()]
        )])
        .grants
        .is_empty());
    assert!(security
        .set_permissions(&db, "new", "b".repeat(64), &[], Some(vec![]))
        .is_err());
    assert!(security.set_restricted(&db, false, false).is_err());
    assert!(security.snapshot(&[]).restricted);
}

#[tokio::test]
async fn cancelled_admitted_permission_retains_package_exclusion_until_sql_settles() {
    use crate::plugins::PluginsManager;
    let root = std::env::temp_dir().join(format!(
        "tunnelde-permission-owner-{}",
        uuid::Uuid::new_v4()
    ));
    let installed = root.join("installed/sample");
    std::fs::create_dir_all(&installed).unwrap();
    std::fs::write(installed.join("tunnelde-plugin.json"), r#"{"id":"sample","name":"Sample","version":"1.0.0","apiVersion":1,"main":"main.js","permissions":["log"]}"#).unwrap();
    std::fs::write(installed.join("main.js"), "").unwrap();
    let plugins = Arc::new(PluginsManager::load(root.join("installed")));
    let info = plugins.list().await.pop().unwrap();
    let database_path = root.join("database.sqlite");
    let db = Database::open(&database_path).unwrap();
    plugins.security.initialize(&db, false).unwrap();
    static SQLITE_WAITING: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    SQLITE_WAITING.store(false, std::sync::atomic::Ordering::Release);
    db.install_busy_handler_for_test(|attempt| {
        SQLITE_WAITING.store(true, std::sync::atomic::Ordering::Release);
        std::thread::sleep(Duration::from_millis(10));
        attempt < 500
    })
    .unwrap();
    // This is a separate SQLite connection, deliberately occupying the writer.
    // The actual production worker can acquire the shared connection/policy,
    // commit its cancellation fence and then wait inside SQLite's busy handler.
    let occupied = rusqlite::Connection::open(&database_path).unwrap();
    occupied.execute_batch("BEGIN IMMEDIATE").unwrap();
    let worker = plugins.clone();
    let database = db.clone();
    let caller = tokio::spawn(async move {
        worker
            .set_permissions(
                &database,
                "sample",
                Some(info.permissions),
                Some(info.fingerprint),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            // Only SQLite's actual busy callback proves the production write
            // passed its cancellation fence; seeing a held policy lock alone
            // can also observe the earlier, still-cancellable admission check.
            if SQLITE_WAITING.load(std::sync::atomic::Ordering::Acquire) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    let retained = plugins.mutations.try_read().is_err();
    // Always release the test's external writer before evaluating assertions.
    occupied.execute_batch("ROLLBACK").unwrap();
    assert!(
        retained,
        "actual admitted worker still owns package exclusion"
    );
    drop(
        tokio::time::timeout(Duration::from_secs(2), plugins.mutations.read())
            .await
            .unwrap(),
    );
    assert!(plugins.security_state().await.grants.contains_key("sample"));
    drop(occupied);
    drop(db);
    drop(plugins);
    std::fs::remove_dir_all(root).unwrap();
}
