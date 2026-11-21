use super::*;
use crate::{
    db::Database, error::AppError, services::settings::mutation::persistence::Write,
    settings::Settings,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::Semaphore;

fn budget() -> (Arc<Budget>, Arc<Semaphore>) {
    let capacity = Arc::new(Semaphore::new(1));
    (
        Arc::new(Budget::with_capacity(capacity.clone(), ERRORS)),
        capacity,
    )
}

async fn available(capacity: Arc<Semaphore>) {
    drop(
        tokio::time::timeout(Duration::from_secs(3), capacity.acquire_owned())
            .await
            .unwrap()
            .unwrap(),
    );
}

#[tokio::test]
async fn cancelled_serial_waiter_keeps_capacity_without_entering_the_operation() {
    let serial = Arc::new(Mutex::new(()));
    let held = serial.lock().await;
    let (budget, capacity) = budget();
    let worker_budget = budget.clone();
    let worker_serial = serial.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (finished, done) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let calls = Arc::new(AtomicUsize::new(0));
    let worker_calls = calls.clone();
    let caller = tokio::spawn(async move {
        worker_budget
            .blocking(move |cancel| {
                entered.send(()).unwrap();
                let result = locked(&worker_serial, cancel, |_| {
                    worker_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                });
                // Cancellation may be observed before blocking_lock is entered.
                // Keep the physical worker alive through the capacity assertions
                // even when that early cancellation has already returned.
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                finished
                    .send(result.as_ref().err().map(ToString::to_string))
                    .unwrap();
                result
            })
            .await
    });
    ready.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert_eq!(
        budget
            .blocking::<()>(|_| panic!("full worker started"))
            .await
            .unwrap_err()
            .to_string(),
        ERRORS.busy
    );
    drop(held);
    release.send(()).unwrap();
    assert_eq!(done.await.unwrap().as_deref(), Some(ERRORS.cancelled));
    available(capacity).await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn settings_wait_deadline_stays_responsive_and_worker_retains_its_slot() {
    let serial = Arc::new(Mutex::new(()));
    let held = serial.lock().await;
    let worker_serial = serial.clone();
    let (budget, capacity) = budget();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let caller = tokio::spawn(async move {
        budget
            .blocking(move |cancel| {
                entered.send(()).unwrap();
                locked::<()>(&worker_serial, cancel, |_| panic!("expired waiter started"))
            })
            .await
    });
    ready.await.unwrap();
    let mut caller = caller;
    assert!(tokio::time::timeout(Duration::from_millis(30), &mut caller)
        .await
        .is_err());
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    drop(held);
    available(capacity).await;
}

#[test]
fn cancellation_during_final_guard_prevents_preferences_and_companion_writes() {
    let db = Database::in_memory().unwrap();
    let previous = Settings::default();
    let before = db
        .with(|conn| crate::services::settings::repository::save(conn, &previous))
        .unwrap();
    let mut next = previous.clone();
    next.theme = "light".into();
    let (cancel, owner) = Cancellation::for_test(ERRORS.cancelled);
    let error = Write {
        db: &db,
        previous: &previous,
        next: &next,
        expected_preferences: Some(&before),
    }
    .save(
        &cancel,
        |_| {
            drop(owner);
            Ok(())
        },
        |_| panic!("cancelled guard wrote companion"),
    )
    .unwrap_err();
    assert_eq!(error.to_string(), ERRORS.cancelled);
    db.with(|conn| {
        assert_eq!(crate::db::settings::load(conn)?.theme, previous.theme);
        assert_eq!(
            crate::services::settings::repository::revision(conn, &previous)?,
            before
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn rejected_authorization_does_not_admit_or_mutate_settings() {
    let db = Database::in_memory().unwrap();
    let previous = Settings::default();
    let before = db
        .with(|conn| crate::services::settings::repository::save(conn, &previous))
        .unwrap();
    let mut next = previous.clone();
    next.theme = "light".into();
    let (cancel, owner) = Cancellation::for_test(ERRORS.cancelled);
    let error = Write {
        db: &db,
        previous: &previous,
        next: &next,
        expected_preferences: Some(&before),
    }
    .save(
        &cancel,
        |_| Err(AppError::validation("revoked")),
        |_| panic!("revoked write executed companion"),
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "revoked");
    drop(owner);
    assert_eq!(cancel.check().unwrap_err().to_string(), ERRORS.cancelled);
    db.with(|conn| {
        assert_eq!(crate::db::settings::load(conn)?.theme, previous.theme);
        assert_eq!(
            crate::services::settings::repository::revision(conn, &previous)?,
            before
        );
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn cancelled_database_waiter_never_starts_sql_or_companion_publication() {
    let db = Arc::new(Database::in_memory().unwrap());
    db.with(|conn| {
        conn.execute_batch("DROP TABLE settings")?;
        Ok(())
    })
    .unwrap();
    let blocker_db = db.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let owner = std::thread::spawn(move || {
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
    let (starting, started) = tokio::sync::oneshot::channel();
    let (finished, done) = tokio::sync::oneshot::channel();
    let caller = tokio::spawn(async move {
        budget
            .blocking(move |cancel| {
                let serial = Mutex::new(());
                let result = locked(&serial, cancel, |_| {
                    let previous = Settings::default();
                    starting.send(()).unwrap();
                    Write {
                        db: &db,
                        previous: &previous,
                        next: &previous,
                        expected_preferences: None,
                    }
                    .save(
                        cancel,
                        |_| panic!("cancelled request reached admission"),
                        |_| panic!("cancelled request wrote companion"),
                    )
                });
                finished
                    .send(result.as_ref().err().map(ToString::to_string))
                    .unwrap();
                result
            })
            .await
    });
    started.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    release.send(()).unwrap();
    assert_eq!(done.await.unwrap().as_deref(), Some(ERRORS.cancelled));
    available(capacity).await;
    owner.join().unwrap();
}

#[tokio::test]
async fn admitted_write_finishes_after_caller_abort_before_following_writer() {
    let db = Arc::new(Database::in_memory().unwrap());
    let worker_db = db.clone();
    let serial = Arc::new(Mutex::new(()));
    let worker_serial = serial.clone();
    let published = Arc::new(AtomicUsize::new(0));
    let worker_published = published.clone();
    let (budget, capacity) = budget();
    let (admitted, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (finished, done) = tokio::sync::oneshot::channel();
    let caller = tokio::spawn(async move {
        budget.blocking(move |cancel| {
            let result = locked(&worker_serial, cancel, |_| {
                let previous = Settings::default();
                let mut next = previous.clone(); next.theme = "light".into();
                let revision = Write {db: &worker_db, previous: &previous, next: &next, expected_preferences: None}
                    .save(cancel, |_| Ok(()), |conn| {
                        assert!(worker_serial.try_lock().is_err());
                        conn.execute("INSERT INTO settings(key,value,updated_at) VALUES('test.companion','selected',0)", [])?;
                        admitted.send(()).unwrap();
                        wait.recv_timeout(Duration::from_secs(5)).unwrap();
                        Ok(())
                    })?;
                cancel.check()?; // Late abort cannot prevent in-memory/effect publication.
                assert!(worker_serial.try_lock().is_err());
                worker_published.store(1, Ordering::Release);
                Ok(revision)
            });
            finished.send(result.as_ref().err().map(ToString::to_string)).unwrap();
            result
        }).await
    });
    ready.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert!(serial.try_lock().is_err());
    assert_eq!(published.load(Ordering::Acquire), 0);
    let following_serial = serial.clone();
    let following_published = published.clone();
    let following = tokio::spawn(async move {
        let _guard = following_serial.lock().await;
        assert_eq!(following_published.load(Ordering::Acquire), 1);
    });
    release.send(()).unwrap();
    assert_eq!(done.await.unwrap(), None);
    following.await.unwrap();
    available(capacity).await;
    db.with(|conn| {
        assert_eq!(crate::db::settings::load(conn)?.theme, "light");
        assert_eq!(
            conn.query_row(
                "SELECT value FROM settings WHERE key='test.companion'",
                [],
                |row| row.get::<_, String>(0)
            )?,
            "selected"
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn stale_guard_and_companion_failure_leave_settings_revision_unchanged() {
    let db = Database::in_memory().unwrap();
    let previous = Settings::default();
    let before = db
        .with(|conn| crate::services::settings::repository::save(conn, &previous))
        .unwrap();
    let mut next = previous.clone();
    next.theme = "light".into();
    let (cancel, _owner) = Cancellation::for_test(ERRORS.cancelled);
    let write = || Write {
        db: &db,
        previous: &previous,
        next: &next,
        expected_preferences: Some(&before),
    };
    assert_eq!(
        Write {
            expected_preferences: Some("stale"),
            ..write()
        }
        .save(&cancel, |_| panic!("stale write admitted"), |_| Ok(()))
        .unwrap_err()
        .to_string(),
        "preferences.staleRevision"
    );
    write()
        .save(
            &cancel,
            |_| Ok(()),
            |_| Err(AppError::validation("companion failed")),
        )
        .unwrap_err();
    db.with(|conn| {
        assert_eq!(crate::db::settings::load(conn)?.theme, previous.theme);
        assert_eq!(
            crate::services::settings::repository::revision(conn, &previous)?,
            before
        );
        Ok(())
    })
    .unwrap();
}
