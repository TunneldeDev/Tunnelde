use super::*;
use crate::services::credentials::{Budget, ERRORS};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::sync::Semaphore;

mod mutations;
mod recovery;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Read,
    Write,
    Delete,
}
type Hook = Arc<dyn Fn(Stage, &str) -> AppResult<()> + Send + Sync>;

#[derive(Default)]
struct Mock {
    values: Mutex<BTreeMap<String, String>>,
    hook: Mutex<Option<Hook>>,
    reads: AtomicUsize,
    writes: AtomicUsize,
    deletes: AtomicUsize,
    write_reply_lost: AtomicBool,
    delete_fails: AtomicBool,
}
impl Mock {
    fn hook(&self, stage: Stage, item: &str) -> AppResult<()> {
        let hook = self.hook.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(stage, item)?;
        }
        Ok(())
    }
}
impl Platform for Mock {
    fn read(&self, item: &str) -> AppResult<Option<String>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.hook(Stage::Read, item)?;
        Ok(self.values.lock().unwrap().get(item).cloned())
    }
    fn write(&self, item: &str, secret: &str) -> AppResult<()> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.hook(Stage::Write, item)?;
        self.values
            .lock()
            .unwrap()
            .insert(item.into(), secret.into());
        if self.write_reply_lost.load(Ordering::SeqCst) {
            return Err(AppError::Ssh("vault.save: controlled reply loss".into()));
        }
        Ok(())
    }
    fn delete(&self, item: &str) -> AppResult<()> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        self.hook(Stage::Delete, item)?;
        if self.delete_fails.load(Ordering::SeqCst) {
            return Err(AppError::Ssh(
                "vault.forget: controlled platform denial".into(),
            ));
        }
        self.values.lock().unwrap().remove(item);
        Ok(())
    }
}

fn fixture() -> (Arc<Database>, Arc<Mock>, Owner, Uuid) {
    let db = Arc::new(Database::in_memory().unwrap());
    db.with(|conn| {
        conn.execute_batch(bindings::SCHEMA)?;
        conn.execute("INSERT INTO settings VALUES ('qa.scope','original',0)", [])?;
        Ok(())
    })
    .unwrap();
    let platform = Arc::new(Mock::default());
    platform
        .values
        .lock()
        .unwrap()
        .insert("saved-host".into(), "old-secret".into());
    (
        db,
        platform,
        Owner::host("saved-host").unwrap(),
        Uuid::new_v4(),
    )
}

fn scope(conn: &Connection) -> AppResult<Stamp> {
    let value: String =
        conn.query_row("SELECT value FROM settings WHERE key='qa.scope'", [], |r| {
            r.get(0)
        })?;
    Ok(Stamp::capture(value.as_bytes()))
}

fn call<T>(effect: impl FnOnce(&Cancellation) -> AppResult<T>) -> AppResult<T> {
    let (job, _guard) = Cancellation::for_test("credentials.cancelled");
    effect(&job)
}

fn item_count(db: &Database) -> i64 {
    db.with(|conn| {
        Ok(
            conn.query_row("SELECT COUNT(*) FROM credential_operations", [], |r| {
                r.get(0)
            })?,
        )
    })
    .unwrap()
}

#[test]
fn native_save_publishes_only_a_confirmed_immutable_item_and_read_uses_that_exact_binding() {
    let (db, platform, owner, run) = fixture();
    let service = Service::new(&db, &*platform, run).unwrap();
    let original = service.capture(owner.clone(), || Ok(()), scope).unwrap();
    assert_eq!(
        call(|job| service.read(&original, job)).unwrap().as_deref(),
        Some("old-secret")
    );
    call(|job| service.save(&original, "new-secret", job)).unwrap();
    assert_eq!(
        platform.values.lock().unwrap().get("saved-host").unwrap(),
        "old-secret"
    );
    assert!(platform
        .values
        .lock()
        .unwrap()
        .keys()
        .any(|key| key.starts_with("tunnelde.credential.v1:")));
    assert_eq!(
        call(|job| service.read(&original, job))
            .unwrap_err()
            .to_string(),
        "credentials.changed"
    );
    let current = service.capture(owner, || Ok(()), scope).unwrap();
    assert_eq!(
        call(|job| service.read(&current, job)).unwrap().as_deref(),
        Some("new-secret")
    );
    assert!(call(|job| service.retire_one(job)).unwrap());
    assert!(!platform.values.lock().unwrap().contains_key("saved-host"));
    assert_eq!(
        call(|job| service.read(&current, job)).unwrap().as_deref(),
        Some("new-secret")
    );
}

#[test]
fn all_platform_callbacks_can_mutate_unrelated_database_state_without_an_authority_guard() {
    let (db, platform, owner, run) = fixture();
    let checked = db.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    *platform.hook.lock().unwrap() = Some(Arc::new(move |_, _| {
        let changed = checked.try_with(|conn| {
            conn.execute(
                "INSERT INTO settings VALUES ('unrelated','responsive',0)
                ON CONFLICT(key) DO UPDATE SET updated_at=updated_at+1",
                [],
            )?;
            Ok(())
        })?;
        assert!(
            changed.is_some(),
            "OS access must not retain the database guard"
        );
        observed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }));
    let service = Service::new(&db, &*platform, run).unwrap();
    let request = service.capture(owner.clone(), || Ok(()), scope).unwrap();
    call(|job| service.save(&request, "new-secret", job)).unwrap();
    let request = service.capture(owner, || Ok(()), scope).unwrap();
    call(|job| service.read(&request, job)).unwrap();
    call(|job| service.retire_one(job)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[test]
fn cancelling_before_native_admission_rolls_back_intent_and_never_touches_the_platform() {
    let (db, platform, owner, run) = fixture();
    let service = Service::new(&db, &*platform, run).unwrap();
    let request = service.capture(owner, || Ok(()), scope).unwrap();
    let (cancelled, pending) = Cancellation::for_test("credentials.cancelled");
    drop(pending);
    assert_eq!(
        service
            .save(&request, "never-written", &cancelled)
            .unwrap_err()
            .to_string(),
        "credentials.cancelled"
    );
    assert_eq!(item_count(&db), 0);
    assert_eq!(platform.writes.load(Ordering::SeqCst), 0);
    assert_eq!(
        service.read(&request, &cancelled).unwrap_err().to_string(),
        "credentials.cancelled"
    );
    assert_eq!(platform.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn policy_or_configuration_changes_before_admission_prevent_both_os_work_and_intent_creation() {
    for policy_change in [true, false] {
        let (db, platform, owner, run) = fixture();
        let service = Service::new(&db, &*platform, run).unwrap();
        let allowed = AtomicBool::new(true);
        let request = service
            .capture(
                owner,
                || {
                    if !allowed.load(Ordering::SeqCst) {
                        return Err(AppError::validation("controlled revoked request"));
                    }
                    Ok(())
                },
                scope,
            )
            .unwrap();
        if policy_change {
            allowed.store(false, Ordering::SeqCst);
        } else {
            db.with(|conn| {
                conn.execute(
                    "UPDATE settings SET value='changed' WHERE key='qa.scope'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        }
        assert!(call(|job| service.save(&request, "not-admitted", job)).is_err());
        assert_eq!(item_count(&db), 0);
        assert_eq!(platform.writes.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn a_changed_binding_or_configuration_discards_the_original_read_without_loading_a_replacement() {
    for binding_change in [true, false] {
        let (db, platform, owner, run) = fixture();
        let service = Service::new(&db, &*platform, run).unwrap();
        let request = service.capture(owner.clone(), || Ok(()), scope).unwrap();
        let changed = db.clone();
        *platform.hook.lock().unwrap() = Some(Arc::new(move |stage, item| {
            assert!(stage == Stage::Read);
            assert_eq!(item, "saved-host");
            changed.with(|conn| {
                transaction(conn, |conn| {
                    if binding_change {
                        bindings::invalidate(conn, &owner)
                    } else {
                        conn.execute(
                            "UPDATE settings SET value='changed' WHERE key='qa.scope'",
                            [],
                        )?;
                        Ok(())
                    }
                })
            })
        }));
        assert_eq!(
            call(|job| service.read(&request, job))
                .unwrap_err()
                .to_string(),
            "credentials.changed"
        );
        assert_eq!(platform.reads.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn unknown_os_write_reply_preserves_original_intent_until_controlled_startup_recovery() {
    let (db, platform, owner, run) = fixture();
    let service = Service::new(&db, &*platform, run).unwrap();
    let request = service.capture(owner.clone(), || Ok(()), scope).unwrap();
    platform.write_reply_lost.store(true, Ordering::SeqCst);
    assert_eq!(
        call(|job| service.save(&request, "unconfirmed-secret", job))
            .unwrap_err()
            .to_string(),
        "vault.save: controlled reply loss"
    );
    assert_eq!(platform.values.lock().unwrap().len(), 2);
    assert_eq!(item_count(&db), 1);
    assert!(!call(|job| service.retire_one(job)).unwrap());
    assert_eq!(platform.deletes.load(Ordering::SeqCst), 0);
    let restart = Service::new(&db, &*platform, Uuid::new_v4()).unwrap();
    assert_eq!(restart.recover_startup_page().unwrap(), 1);
    assert!(call(|job| restart.retire_one(job)).unwrap());
    assert_eq!(platform.values.lock().unwrap().len(), 1);
    assert_eq!(
        platform.values.lock().unwrap().get("saved-host").unwrap(),
        "old-secret"
    );
    assert_eq!(item_count(&db), 0);
    assert_eq!(
        platform.writes.load(Ordering::SeqCst),
        1,
        "recovery never repeats a logical save"
    );
}

#[test]
fn failed_publication_preserves_original_database_error_and_retires_only_confirmed_staged_item() {
    let (db, platform, owner, run) = fixture();
    db.with(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER reject_publication BEFORE INSERT ON credential_bindings
        BEGIN SELECT RAISE(ABORT, 'controlled publication failure'); END;",
        )?;
        Ok(())
    })
    .unwrap();
    let service = Service::new(&db, &*platform, run).unwrap();
    let request = service.capture(owner, || Ok(()), scope).unwrap();
    let error = call(|job| service.save(&request, "staged-secret", job)).unwrap_err();
    assert!(error.to_string().contains("controlled publication failure"));
    assert!(call(|job| service.retire_one(job)).unwrap());
    assert_eq!(platform.values.lock().unwrap().len(), 1);
    assert_eq!(
        platform.values.lock().unwrap().get("saved-host").unwrap(),
        "old-secret"
    );
    assert_eq!(item_count(&db), 0);
}

#[test]
fn failed_platform_cleanup_retains_its_claim_without_retrying_or_deleting_a_replacement() {
    let (db, platform, owner, run) = fixture();
    let service = Service::new(&db, &*platform, run).unwrap();
    let request = service.capture(owner, || Ok(()), scope).unwrap();
    call(|job| service.save(&request, "replacement-secret", job)).unwrap();
    platform.delete_fails.store(true, Ordering::SeqCst);
    assert_eq!(
        call(|job| service.retire_one(job)).unwrap_err().to_string(),
        "vault.forget: controlled platform denial"
    );
    assert!(!call(|job| service.retire_one(job)).unwrap());
    assert_eq!(platform.deletes.load(Ordering::SeqCst), 1);
    platform.delete_fails.store(false, Ordering::SeqCst);
    let restart = Service::new(&db, &*platform, Uuid::new_v4()).unwrap();
    assert_eq!(restart.recover_startup_page().unwrap(), 1);
    assert!(call(|job| restart.retire_one(job)).unwrap());
    let values = platform.values.lock().unwrap();
    assert_eq!(values.len(), 1);
    assert!(values.values().any(|value| value == "replacement-secret"));
}

#[test]
fn forget_is_a_durable_tombstone_and_never_performs_os_deletion_under_authority() {
    let (db, platform, owner, run) = fixture();
    let service = Service::new(&db, &*platform, run).unwrap();
    let request = service.capture(owner.clone(), || Ok(()), scope).unwrap();
    platform.delete_fails.store(true, Ordering::SeqCst);
    call(|job| service.forget(&request, job)).unwrap();
    assert_eq!(platform.deletes.load(Ordering::SeqCst), 0);
    let current = service.capture(owner, || Ok(()), scope).unwrap();
    assert!(call(|job| service.read(&current, job)).unwrap().is_none());
    assert_eq!(platform.reads.load(Ordering::SeqCst), 0);
    assert!(call(|job| service.retire_one(job)).is_err());
    assert!(platform.values.lock().unwrap().contains_key("saved-host"));
}

#[test]
fn cancellation_before_cleanup_admission_leaves_the_original_task_unclaimed() {
    let (db, platform, owner, run) = fixture();
    let service = Service::new(&db, &*platform, run).unwrap();
    let request = service.capture(owner, || Ok(()), scope).unwrap();
    call(|job| service.forget(&request, job)).unwrap();
    let (job, pending) = Cancellation::for_test("credentials.cancelled");
    drop(pending);
    assert_eq!(
        service.retire_one(&job).unwrap_err().to_string(),
        "credentials.cancelled"
    );
    assert_eq!(platform.deletes.load(Ordering::SeqCst), 0);
    assert!(call(|job| service.retire_one(job)).unwrap());
}

#[test]
fn request_cannot_be_reused_by_a_different_database_or_runtime() {
    let (db, platform, owner, run) = fixture();
    let service = Service::new(&db, &*platform, run).unwrap();
    let request = service.capture(owner, || Ok(()), scope).unwrap();
    let other = Service::new(&db, &*platform, Uuid::new_v4()).unwrap();
    assert_eq!(
        call(|job| other.save(&request, "not-written", job))
            .unwrap_err()
            .to_string(),
        "credentials.changed"
    );
    let (other_db, _, _, _) = fixture();
    let other = Service::new(&other_db, &*platform, run).unwrap();
    assert_eq!(
        call(|job| other.read(&request, job))
            .unwrap_err()
            .to_string(),
        "credentials.changed"
    );
    assert!(Service::new(&db, &*platform, Uuid::nil()).is_err());
    assert_eq!(platform.writes.load(Ordering::SeqCst), 0);
    assert_eq!(platform.reads.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn abandoned_admitted_worker_keeps_capacity_and_cannot_publish_over_a_recreated_owner() {
    let (db, platform, owner, run) = fixture();
    let capacity = Arc::new(Semaphore::new(1));
    let budget = Arc::new(Budget::with_capacity(capacity.clone(), ERRORS));
    let (entered, ready) = tokio::sync::oneshot::channel();
    let entered = Mutex::new(Some(entered));
    let (release, wait) = std::sync::mpsc::channel();
    let wait = Mutex::new(wait);
    *platform.hook.lock().unwrap() = Some(Arc::new(move |stage, _| {
        if stage == Stage::Write {
            let signal = { entered.lock().unwrap().take() };
            if let Some(entered) = signal {
                entered.send(()).unwrap();
                wait.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
        }
        Ok(())
    }));
    let worker_db = db.clone();
    let worker_platform = platform.clone();
    let worker_owner = owner.clone();
    let worker_budget = budget.clone();
    let request = tokio::spawn(async move {
        worker_budget
            .blocking(move |job| {
                let service = Service::new(&worker_db, &*worker_platform, run)?;
                let request = service.capture(worker_owner, || Ok(()), scope)?;
                service.save(&request, "obsolete-secret", job)
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert_eq!(
        budget.blocking(|_| Ok(())).await.unwrap_err().to_string(),
        "credentials.busy"
    );
    assert!(db
        .try_with(|conn| transaction(conn, |conn| bindings::invalidate(conn, &owner)))
        .unwrap()
        .is_some());
    let service = Service::new(&db, &*platform, run).unwrap();
    let fresh = service.capture(owner.clone(), || Ok(()), scope).unwrap();
    call(|job| service.save(&fresh, "replacement-secret", job)).unwrap();
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while capacity.available_permits() != 1 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    let fresh = service.capture(owner, || Ok(()), scope).unwrap();
    assert_eq!(
        call(|job| service.read(&fresh, job)).unwrap().as_deref(),
        Some("replacement-secret")
    );
    while call(|job| service.retire_one(job)).unwrap() {}
    let values = platform.values.lock().unwrap();
    assert_eq!(values.len(), 1);
    assert!(values.values().any(|value| value == "replacement-secret"));
}
