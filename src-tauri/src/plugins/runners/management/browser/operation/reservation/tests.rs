use super::*;
use crate::plugins::runners::management::browser::{
    registry::Registry, tests::pending as empty_pending,
};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

fn unexpected_capture(_: Review) -> std::future::Ready<AppResult<()>> {
    panic!("credentials captured without an admissible operation")
}

fn pending() -> Arc<Pending> {
    let pending = empty_pending();
    pending.connection.lock().unwrap().review = Some(
        serde_json::from_value(serde_json::json!({
            "hostId": "original", "revision": "a".repeat(64)
        }))
        .unwrap(),
    );
    pending
}

#[tokio::test]
async fn cancellation_before_capture_skips_validation_and_credentials() {
    let pending = pending();
    pending.cancelled.send_replace(true);
    let result = Reservation::capture(
        &pending,
        || panic!("cancelled validation ran"),
        unexpected_capture,
    )
    .await;
    assert!(result.is_err());
    assert!(!pending.connection.lock().unwrap().busy);
}

#[tokio::test]
async fn successful_capture_owns_the_busy_slot_until_the_operation_finishes() {
    let pending = pending();
    let checks = AtomicUsize::new(0);
    let (reservation, value) = Reservation::capture(
        &pending,
        || {
            checks.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        |review| async move {
            assert_eq!(review.host_id, "original");
            assert_eq!(review.identity(), "a".repeat(64));
            Ok(42)
        },
    )
    .await
    .unwrap();
    assert_eq!(value, 42);
    assert_eq!(checks.load(Ordering::SeqCst), 2);
    let competing = Reservation::capture(&pending, || Ok(()), unexpected_capture).await;
    assert!(competing.is_err());
    assert!(pending.connection.lock().unwrap().busy);
    drop(reservation);
    assert!(!pending.connection.lock().unwrap().busy);
}

#[tokio::test]
async fn failed_capture_releases_the_slot_for_retry() {
    let pending = pending();
    let failure = Reservation::capture(
        &pending,
        || Ok(()),
        |_| async { Err::<(), _>(AppError::validation("ssh.connectionChanged")) },
    )
    .await;
    assert!(failure.is_err());
    assert!(!pending.connection.lock().unwrap().busy);
    let (reservation, ()) = Reservation::capture(&pending, || Ok(()), |_| async { Ok(()) })
        .await
        .unwrap();
    assert!(pending.connection.lock().unwrap().busy);
    drop(reservation);
    assert!(!pending.connection.lock().unwrap().busy);
}

#[tokio::test]
async fn destination_changed_during_capture_rejects_the_result_without_recapturing() {
    let pending = pending();
    let current = AtomicBool::new(true);
    let captures = AtomicUsize::new(0);
    let result = Reservation::capture(
        &pending,
        || {
            if current.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(AppError::validation("plugin.runners.destinationChanged"))
            }
        },
        |review| {
            let captures = &captures;
            let pending = &pending;
            let current = &current;
            async move {
                captures.fetch_add(1, Ordering::SeqCst);
                assert_eq!(review.host_id, "original");
                assert_eq!(review.identity(), "a".repeat(64));
                // Capture can inspect the connection because it owns no mutex guard.
                assert!(pending.connection.try_lock().unwrap().busy);
                current.store(false, Ordering::SeqCst);
                Ok(())
            }
        },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(captures.load(Ordering::SeqCst), 1);
    assert!(!pending.connection.lock().unwrap().busy);
}

#[tokio::test]
async fn registry_cancellation_does_not_wait_for_a_slow_credential_worker() {
    let pending = pending();
    let registry = Arc::new(Registry::default());
    registry.insert("slow".into(), pending.clone()).unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let (finished, completed) = tokio::sync::oneshot::channel();
    let task_pending = pending.clone();
    let task = tokio::spawn(async move {
        Reservation::capture(
            &task_pending,
            || Ok(()),
            |_| async {
                crate::services::credentials::inspect(move || {
                    started.send(()).unwrap();
                    blocked.recv_timeout(Duration::from_secs(10)).unwrap();
                    let _ = finished.send(());
                    Ok(())
                })
                .await
                .unwrap();
                Ok(())
            },
        )
        .await
        .map(|(reservation, ())| drop(reservation))
    });
    ready.await.unwrap();
    // A separate thread gives a bounded failure instead of hanging this test's
    // runtime if capture accidentally retains the cancellation mutex again.
    let cancelling = registry.clone();
    let (removed, removal) = tokio::sync::oneshot::channel();
    let cancellation = std::thread::spawn(move || {
        cancelling.remove("slow").unwrap();
        let _ = removed.send(());
    });
    let cancelled_promptly = tokio::time::timeout(Duration::from_secs(2), removal).await;
    let ended_promptly = tokio::time::timeout(Duration::from_secs(2), task).await;
    let released = release.send(());
    cancellation.join().unwrap();
    completed.await.unwrap();
    assert!(released.is_ok());
    assert!(cancelled_promptly.unwrap().is_ok());
    assert!(ended_promptly.unwrap().unwrap().is_err());
    assert!(*pending.cancelled.borrow());
    assert!(!pending.connection.lock().unwrap().busy);
    assert!(pending.connection.lock().unwrap().session.is_none());
    let retry = Reservation::capture(&pending, || Ok(()), unexpected_capture).await;
    assert!(retry.is_err());
}

#[tokio::test]
async fn abandoned_capture_releases_its_slot_and_late_worker_cannot_clear_a_new_owner() {
    let pending = pending();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let (finished, completed) = tokio::sync::oneshot::channel();
    let task_pending = pending.clone();
    let task = tokio::spawn(async move {
        Reservation::capture(
            &task_pending,
            || Ok(()),
            |_| async {
                crate::services::credentials::inspect(move || {
                    started.send(()).unwrap();
                    blocked.recv_timeout(Duration::from_secs(10)).unwrap();
                    let _ = finished.send(());
                    Ok(())
                })
                .await
                .unwrap();
                Ok(())
            },
        )
        .await
        .map(|(reservation, ())| drop(reservation))
    });
    ready.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(!pending.connection.lock().unwrap().busy);
    let (next, ()) = Reservation::capture(&pending, || Ok(()), |_| async { Ok(()) })
        .await
        .unwrap();
    release.send(()).unwrap();
    completed.await.unwrap();
    assert!(pending.connection.lock().unwrap().busy);
    drop(next);
    assert!(!pending.connection.lock().unwrap().busy);
}

#[tokio::test]
async fn absent_review_fails_without_occupying_the_connection() {
    let pending = empty_pending();
    let result = Reservation::capture(&pending, || Ok(()), unexpected_capture).await;
    assert!(result.is_err());
    assert!(!pending.connection.lock().unwrap().busy);
}

fn connected(acquired: bool) -> Arc<Pending> {
    let pending = pending();
    {
        let mut connection = pending.connection.lock().unwrap();
        connection.acquired = acquired;
        connection.session = Some(crate::ssh::SessionInfo {
            id: "private-session".into(),
            host_id: "original".into(),
            title: "Original".into(),
            address: "qa@original:22".into(),
            cols: 80,
            rows: 24,
            connected_at: 0,
            terminal: false,
            purpose: None,
        });
    }
    pending
}

#[test]
fn acceptance_reserves_existing_private_connection_and_preserves_its_original_review() {
    let pending = connected(true);
    let (reservation, review) = Reservation::accept(&pending, || Ok(())).unwrap();
    assert_eq!(review.unwrap().identity(), "a".repeat(64));
    assert!(pending.connection.lock().unwrap().busy);
    assert_eq!(
        Reservation::accept(&pending, || Ok(()))
            .err()
            .unwrap()
            .to_string(),
        "plugin.runners.busy"
    );
    assert!(pending.connection.lock().unwrap().session.is_some());
    drop(reservation);
    assert!(!pending.connection.lock().unwrap().busy);
}

#[test]
fn reusable_session_acceptance_does_not_require_or_create_an_ssh_review() {
    let pending = connected(false);
    pending.connection.lock().unwrap().review = None;
    let (reservation, review) = Reservation::accept(&pending, || Ok(())).unwrap();
    assert!(review.is_none());
    drop(reservation);
    let mut connection = pending.connection.lock().unwrap();
    connection.acquired = true;
    drop(connection);
    assert_eq!(
        Reservation::accept(&pending, || Ok(()))
            .err()
            .unwrap()
            .to_string(),
        "plugin.runners.browserExpired"
    );
    assert!(!pending.connection.lock().unwrap().busy);
}

#[tokio::test(flavor = "current_thread")]
async fn final_acceptance_os_observation_can_be_cancelled_without_waiting_for_the_read() {
    let pending = connected(true);
    let registry = Arc::new(Registry::default());
    registry.insert("accept".into(), pending.clone()).unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (settled, done) = tokio::sync::oneshot::channel();
    let task_pending = pending.clone();
    let task = tokio::spawn(async move {
        let (_reservation, review) = Reservation::accept(&task_pending, || Ok(()))?;
        assert_eq!(review.unwrap().identity(), "a".repeat(64));
        registry::guard(
            &task_pending,
            crate::services::credentials::inspect(move || {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(10)).unwrap();
                settled.send(()).unwrap();
                Ok(())
            }),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    // Final observation has no registry/connection guard. A separate current
    // operation and the cancellation path remain available while the OS waits.
    registry
        .with_current(&pending, || {
            assert!(pending.connection.try_lock().unwrap().busy);
            Ok(())
        })
        .unwrap();
    let cancelled = registry.remove("accept").unwrap();
    assert!(Arc::ptr_eq(&pending, &cancelled));
    let ended = tokio::time::timeout(Duration::from_secs(2), task).await;
    release.send(()).unwrap();
    done.await.unwrap();
    assert!(ended.unwrap().unwrap().is_err());
    assert!(!pending.connection.lock().unwrap().busy);
    assert!(pending.connection.lock().unwrap().acquired);
}
