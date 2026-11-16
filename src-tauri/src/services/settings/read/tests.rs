use super::*;
use crate::error::AppError;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
#[path = "support.rs"]
mod support;
use support::*;

#[tokio::test(flavor = "current_thread")]
async fn held_database_does_not_stall_the_preferences_runtime_heartbeat() {
    let fixture = Fixture::new();
    let held = HeldDatabase::lock(fixture.clone()).await;
    let (budget, _) = budget();
    let started = Instant::now();
    let heartbeat = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        started.elapsed()
    });
    let reader = tokio::spawn(async move {
        budget
            .blocking(move |cancel| fixture.run(|| cancel.check(), projection::snapshot))
            .await
    });
    let elapsed = heartbeat.await.unwrap();
    drop(held);
    reader.await.unwrap().unwrap();
    assert!(
        elapsed < Duration::from_secs(1),
        "preference revision read stalled runtime heartbeat for {elapsed:?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn database_wait_deadline_retains_capacity_and_prevents_late_sql() {
    let fixture = Fixture::new();
    fixture.remove_settings_table();
    let held = HeldDatabase::lock(fixture.clone()).await;
    let (budget, capacity) = budget();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (finished, done) = tokio::sync::oneshot::channel();
    let reader_budget = budget.clone();
    let mut caller = tokio::spawn(async move {
        reader_budget
            .blocking(move |cancel| {
                let checks = AtomicUsize::new(0);
                let entered = std::sync::Mutex::new(Some(entered));
                let result = fixture.run(
                    || {
                        cancel.check()?;
                        if checks.fetch_add(1, Ordering::SeqCst) == 1 {
                            entered.lock().unwrap().take().unwrap().send(()).unwrap();
                        }
                        Ok(())
                    },
                    projection::snapshot,
                );
                finished
                    .send(result.as_ref().err().map(ToString::to_string))
                    .unwrap();
                result
            })
            .await
    });
    ready.await.unwrap();
    let started = Instant::now();
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut caller)
        .await
        .is_err());
    assert!(started.elapsed() < Duration::from_secs(1));
    caller.abort();
    assert!(caller.await.err().expect("aborted").is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    let error = budget
        .blocking::<()>(|_| panic!("busy read must not start"))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), ERRORS.busy);
    drop(held);
    assert_eq!(done.await.unwrap().as_deref(), Some(ERRORS.cancelled));
    available(capacity).await;
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_settings_lock_waiter_never_reads_values_or_revision() {
    let fixture = Fixture::new();
    fixture.remove_settings_table();
    let guard = fixture.serial.lock().await;
    let (budget, capacity) = budget();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (finished, done) = tokio::sync::oneshot::channel();
    let worker = fixture.clone();
    let caller = tokio::spawn(async move {
        budget
            .blocking(move |cancel| {
                let entered = std::sync::Mutex::new(Some(entered));
                let result = ordered(
                    &worker.db,
                    &worker.serial,
                    || panic!("cancelled waiter must not read settings"),
                    || {
                        cancel.check()?;
                        if let Some(entered) = entered.lock().unwrap().take() {
                            entered.send(()).unwrap();
                        }
                        Ok(())
                    },
                    || Ok(()),
                    projection::snapshot,
                );
                finished
                    .send(result.as_ref().err().map(ToString::to_string))
                    .unwrap();
                result
            })
            .await
    });
    ready.await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    caller.abort();
    assert!(caller.await.err().expect("aborted").is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    drop(guard);
    assert_eq!(done.await.unwrap().as_deref(), Some(ERRORS.cancelled));
    available(capacity).await;
}

#[tokio::test]
async fn revoked_reader_is_rechecked_after_database_wait_before_projection() {
    let fixture = Fixture::new();
    let held = HeldDatabase::lock(fixture.clone()).await;
    let allowed = Arc::new(AtomicBool::new(true));
    let check_allowed = allowed.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (budget, _) = budget();
    let reader = tokio::spawn(async move {
        budget
            .blocking(move |cancel| {
                let checks = AtomicUsize::new(0);
                let entered = std::sync::Mutex::new(Some(entered));
                ordered(
                    &fixture.db,
                    &fixture.serial,
                    || fixture.settings.read().unwrap().clone(),
                    || cancel.check(),
                    || {
                        if !check_allowed.load(Ordering::Acquire) {
                            return Err(AppError::validation("revoked"));
                        }
                        if checks.fetch_add(1, Ordering::SeqCst) == 1 {
                            entered.lock().unwrap().take().unwrap().send(()).unwrap();
                        }
                        Ok(())
                    },
                    |_, _| -> AppResult<contracts::Snapshot> {
                        panic!("revoked read must not project private preferences")
                    },
                )
            })
            .await
    });
    ready.await.unwrap();
    allowed.store(false, Ordering::Release);
    drop(held);
    assert_eq!(
        reader.await.unwrap().err().expect("revoked").to_string(),
        "revoked"
    );
}

#[tokio::test]
async fn snapshot_waits_for_previous_publication_and_excludes_following_writer() {
    let fixture = Fixture::new();
    let held = fixture.serial.lock().await;
    let (budget, _) = budget();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (projecting, projected) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let worker = fixture.clone();
    let reader = tokio::spawn(async move {
        budget
            .blocking(move |cancel| {
                let started = std::sync::Mutex::new(Some(started));
                worker.run(
                    || {
                        cancel.check()?;
                        if let Some(started) = started.lock().unwrap().take() {
                            started.send(()).unwrap();
                        }
                        Ok(())
                    },
                    |current, revision| {
                        assert!(worker.serial.try_lock().is_err());
                        projecting.send(()).unwrap();
                        wait.recv_timeout(Duration::from_secs(5)).unwrap();
                        projection::snapshot(current, revision)
                    },
                )
            })
            .await
    });
    ready.await.unwrap();
    let mut changed = fixture.settings.read().unwrap().clone();
    changed.theme = "light".into();
    let revision = fixture.save(changed);
    drop(held);
    projected.await.unwrap();
    assert!(fixture.serial.try_lock().is_err());
    release.send(()).unwrap();
    let snapshot = reader.await.unwrap().unwrap();
    assert_eq!(snapshot.revision, revision);
    assert_eq!(snapshot.values["appearance"]["theme"], "light");
    assert!(fixture.serial.try_lock().is_ok());
}

#[tokio::test]
async fn unchanged_observation_preserves_wire_shape_without_snapshot() {
    let fixture = Fixture::new();
    let held = fixture.serial.lock().await;
    let current = fixture.settings.read().unwrap().clone();
    let revision = fixture.save(current);
    drop(held);
    let (budget, _) = budget();
    let expected = revision.clone();
    let observation = budget
        .blocking(move |cancel| {
            fixture.run(
                || cancel.check(),
                |current, revision| {
                    observation::project(
                        current,
                        revision,
                        contracts::Observe {
                            revision: Some(expected),
                        },
                    )
                },
            )
        })
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(observation).unwrap(),
        serde_json::json!({
            "version":1,"revision":revision,"changed":false
        })
    );
}

#[test]
fn revocation_during_projection_rejects_publication() {
    let fixture = Fixture::new();
    let allowed = AtomicBool::new(true);
    let result = ordered(
        &fixture.db,
        &fixture.serial,
        || fixture.settings.read().unwrap().clone(),
        || Ok(()),
        || {
            if allowed.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err(AppError::validation("revoked"))
            }
        },
        |current, revision| {
            let value = projection::snapshot(current, revision)?;
            allowed.store(false, Ordering::Release);
            Ok(value)
        },
    );
    assert_eq!(result.err().expect("revoked").to_string(), "revoked");
}

#[test]
fn authorization_never_holds_the_database_lock() {
    let fixture = Fixture::new();
    let checks = AtomicUsize::new(0);
    let snapshot = ordered(
        &fixture.db,
        &fixture.serial,
        || fixture.settings.read().unwrap().clone(),
        || Ok(()),
        || {
            assert!(fixture.db.try_with(|_| Ok(())).unwrap().is_some());
            checks.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        projection::snapshot,
    )
    .unwrap();
    assert_eq!(checks.load(Ordering::SeqCst), 4);
    assert!(!snapshot.revision.is_empty());
}
