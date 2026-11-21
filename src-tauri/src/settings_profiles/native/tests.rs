use super::*;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

#[tokio::test(flavor = "current_thread")]
async fn native_profile_catalogue_does_not_stall_runtime_heartbeat() {
    let db = Arc::new(Database::in_memory().unwrap());
    let blocker_db = db.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let blocker = std::thread::spawn(move || {
        blocker_db
            .with(|_| {
                entered.send(()).unwrap();
                std::thread::sleep(Duration::from_secs(2));
                Ok(())
            })
            .unwrap();
    });
    ready.await.unwrap();
    let started = Instant::now();
    let heartbeat = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        started.elapsed()
    });
    let caller = tokio::spawn(async move {
        super::super::worker::blocking(move |cancel| read(&db, cancel)).await
    });
    let elapsed = heartbeat.await.unwrap();
    caller.await.unwrap().unwrap();
    blocker.join().unwrap();
    assert!(
        elapsed < Duration::from_secs(1),
        "native Profile catalogue stalled heartbeat for {elapsed:?}"
    );
}

fn budget() -> (
    Arc<crate::services::operations::Budget>,
    Arc<tokio::sync::Semaphore>,
) {
    let capacity = Arc::new(tokio::sync::Semaphore::new(1));
    let budget = crate::services::operations::Budget::with_capacity(
        capacity.clone(),
        crate::services::operations::Errors {
            domain: "profiles.operation",
            busy: "profiles.operation.busy",
            cancelled: "profiles.operation.cancelled",
            failed: "profiles.operation.unavailable",
        },
    );
    (Arc::new(budget), capacity)
}

#[tokio::test]
async fn cancelled_profile_database_waiters_never_read_or_mutate_and_retain_capacity() {
    for operation in ["read", "save", "delete"] {
        let db = Arc::new(Database::in_memory().unwrap());
        let profile = db
            .with(|conn| {
                upsert(
                    conn,
                    None,
                    "Work".into(),
                    serde_json::json!({"theme":"dark"}),
                )
            })
            .unwrap()
            .remove(0);
        let before = db.with(repository::read).unwrap().revision;
        let blocker_db = db.clone();
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let blocker = std::thread::spawn(move || {
            blocker_db
                .with(|_| {
                    entered.send(()).unwrap();
                    wait.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(())
                })
                .unwrap()
        });
        ready.await.unwrap();
        let (budget, capacity) = budget();
        let worker_budget = budget.clone();
        let worker_db = db.clone();
        let (started, starting) = tokio::sync::oneshot::channel();
        let (finished, done) = tokio::sync::oneshot::channel();
        let (allow_exit, exit) = std::sync::mpsc::channel();
        let caller = tokio::spawn(async move {
            worker_budget
                .blocking(move |cancel| {
                    started.send(()).unwrap();
                    let change = if operation == "delete" {
                        Change::Delete { id: profile.id }
                    } else {
                        Change::Save {
                            id: None,
                            name: "Late".into(),
                            settings: serde_json::json!({"theme":"light"}),
                        }
                    };
                    let result = if operation == "read" {
                        read(&worker_db, cancel)
                    } else {
                        mutate(&worker_db, cancel, change)
                    };
                    finished
                        .send(result.as_ref().err().map(ToString::to_string))
                        .unwrap();
                    // Cancellation may finish the DB wait immediately. Keep the
                    // worker alive until the test has checked its permit.
                    exit.recv_timeout(Duration::from_secs(5)).unwrap();
                    result
                })
                .await
        });
        starting.await.unwrap();
        caller.abort();
        assert!(matches!(caller.await, Err(error) if error.is_cancelled()));
        assert_eq!(capacity.available_permits(), 0);
        assert_eq!(
            budget
                .blocking::<()>(|_| panic!("full profile worker started"))
                .await
                .unwrap_err()
                .to_string(),
            "profiles.operation.busy"
        );
        release.send(()).unwrap();
        assert_eq!(
            done.await.unwrap().as_deref(),
            Some("profiles.operation.cancelled")
        );
        allow_exit.send(()).unwrap();
        drop(
            tokio::time::timeout(Duration::from_secs(3), capacity.acquire_owned())
                .await
                .unwrap()
                .unwrap(),
        );
        blocker.join().unwrap();
        let after = db.with(repository::read).unwrap();
        assert_eq!(before, after.revision);
        assert_eq!(after.profiles.len(), 1);
    }
}

#[test]
fn cancellation_in_final_native_profile_guard_preserves_body_generation_and_selection() {
    let db = Database::in_memory().unwrap();
    let before = db.with(repository::read).unwrap().revision;
    let (cancel, owner) = Cancellation::for_test("profiles.operation.cancelled");
    db.with(|conn| {
        let result = upsert_guarded(
            conn,
            None,
            "Work".into(),
            serde_json::json!({"theme":"dark"}),
            || {
                drop(owner);
                cancel.commit()
            },
        );
        assert_eq!(
            result.err().unwrap().to_string(),
            "profiles.operation.cancelled"
        );
        Ok(())
    })
    .unwrap();
    let after = db.with(repository::read).unwrap();
    assert!(after.profiles.is_empty());
    assert_eq!(after.revision, before);
    assert!(after.active_id.is_none());
}

#[tokio::test]
async fn admitted_native_profile_write_completes_publication_after_caller_abort() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let db = Arc::new(Database::in_memory().unwrap());
    let worker_db = db.clone();
    let published = Arc::new(AtomicBool::new(false));
    let worker_published = published.clone();
    let (budget, capacity) = budget();
    let (committed, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let caller = tokio::spawn(async move {
        budget
            .blocking(move |cancel| {
                mutate(
                    &worker_db,
                    cancel,
                    Change::Save {
                        id: None,
                        name: "Work".into(),
                        settings: serde_json::json!({"theme":"dark"}),
                    },
                )?;
                committed.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                cancel.check()?;
                worker_published.store(true, Ordering::Release);
                Ok(())
            })
            .await
    });
    ready.await.unwrap();
    caller.abort();
    assert!(matches!(caller.await, Err(error) if error.is_cancelled()));
    assert_eq!(capacity.available_permits(), 0);
    assert!(!published.load(Ordering::Acquire));
    assert_eq!(db.with(load).unwrap().len(), 1);
    release.send(()).unwrap();
    drop(
        tokio::time::timeout(Duration::from_secs(3), capacity.acquire_owned())
            .await
            .unwrap()
            .unwrap(),
    );
    assert!(published.load(Ordering::Acquire));
}
