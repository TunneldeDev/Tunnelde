use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn pending() -> Arc<Pending> {
    super::super::tests::pending()
}

fn live(pending: &Pending) -> AppResult<()> {
    if *pending.cancelled.borrow() {
        Err(AppError::validation("plugin.runners.browserExpired"))
    } else {
        Ok(())
    }
}

#[tokio::test]
async fn cancellation_is_registered_and_connection_unlocked_while_capture_waits() {
    let registry = Registry::default();
    let pending = pending();
    let preparation = Preparation::begin(&registry, "request".into(), pending.clone()).unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let mut capture = Box::pin(preparation.capture(|| live(&pending), async {
        started.send(()).unwrap();
        std::future::pending::<AppResult<((), Option<Review>)>>().await
    }));
    tokio::select! {
        result = &mut capture => panic!("unexpected preparation result: {result:?}"),
        _ = ready => {}
    }
    assert!(Arc::ptr_eq(&pending, &registry.get("request").unwrap()));
    assert!(pending.connection.try_lock().unwrap().busy);
    registry.remove("request").unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(2), capture)
        .await
        .unwrap()
        .unwrap_err()
        .to_string()
        .contains("browserExpired"));
    assert!(registry.get("request").is_err());
}

#[tokio::test]
async fn dropping_preparation_releases_registry_and_coordinator_admission() {
    let coordinator = super::super::super::super::Coordinator::default();
    let mut owned = Arc::try_unwrap(pending()).ok().unwrap();
    owned._lease = coordinator.admit("plugin", "record").unwrap();
    let pending = Arc::new(owned);
    let registry = Registry::default();
    let preparation = Preparation::begin(&registry, "request".into(), pending.clone()).unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let mut capture = Box::pin(preparation.capture(|| live(&pending), async {
        started.send(()).unwrap();
        std::future::pending::<AppResult<((), Option<Review>)>>().await
    }));
    tokio::select! {
        result = &mut capture => panic!("unexpected preparation result: {result:?}"),
        _ = ready => {}
    }
    assert!(coordinator.admit("plugin", "record").is_err());
    drop(capture);
    assert!(registry.get("request").is_err());
    assert!(*pending.cancelled.borrow());
    drop(pending);
    assert!(coordinator.admit("plugin", "record").is_ok());
}

#[tokio::test]
async fn stale_record_before_capture_does_not_read_credentials_or_keep_a_slot() {
    let registry = Registry::default();
    let pending = pending();
    let reads = AtomicUsize::new(0);
    let result = Preparation::begin(&registry, "request".into(), pending.clone())
        .unwrap()
        .capture(
            || Err(AppError::validation("original-record-error")),
            async {
                reads.fetch_add(1, Ordering::SeqCst);
                Ok(((), None))
            },
        )
        .await;
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("original-record-error"));
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    assert!(registry.get("request").is_err());
}

#[tokio::test]
async fn record_changed_during_capture_is_rejected_before_publishing_readiness() {
    let registry = Registry::default();
    let pending = pending();
    let current = AtomicBool::new(true);
    let result = Preparation::begin(&registry, "request".into(), pending.clone())
        .unwrap()
        .capture(
            || {
                if current.load(Ordering::SeqCst) {
                    live(&pending)
                } else {
                    Err(AppError::validation("changed-record"))
                }
            },
            async {
                current.store(false, Ordering::SeqCst);
                Ok(((), None))
            },
        )
        .await;
    assert!(result.unwrap_err().to_string().contains("changed-record"));
    assert!(registry.get("request").is_err());
    assert!(pending.connection.lock().unwrap().review.is_none());
    assert!(*pending.cancelled.borrow());
}

#[tokio::test]
async fn failed_os_capture_keeps_original_error_and_removes_pending_request() {
    let registry = Registry::default();
    let pending = pending();
    let result = Preparation::begin(&registry, "request".into(), pending.clone())
        .unwrap()
        .capture(|| live(&pending), async {
            Err::<((), Option<Review>), _>(AppError::validation("credentials.os-failure"))
        })
        .await;
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("credentials.os-failure"));
    assert!(registry.get("request").is_err());
}

#[tokio::test]
async fn cancelled_capture_cannot_remove_replacement_or_publish_a_late_review() {
    let registry = Registry::default();
    let old = pending();
    let preparation = Preparation::begin(&registry, "same".into(), old.clone()).unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let mut capture = Box::pin(preparation.capture(|| live(&old), async {
        started.send(()).unwrap();
        released.await.unwrap();
        Ok(((), None))
    }));
    tokio::select! {
        result = &mut capture => panic!("unexpected preparation result: {result:?}"),
        _ = ready => {}
    }
    registry.remove("same").unwrap();
    let replacement = pending();
    registry.insert("same".into(), replacement.clone()).unwrap();
    release.send(()).unwrap();
    assert!(capture.await.is_err());
    assert!(Arc::ptr_eq(&replacement, &registry.get("same").unwrap()));
    assert!(!*replacement.cancelled.borrow());
    assert!(old.connection.lock().unwrap().review.is_none());
}

#[tokio::test]
async fn successful_preparation_keeps_request_ready_until_explicit_cancellation() {
    let registry = Registry::default();
    let pending = pending();
    let review: Review = serde_json::from_value(serde_json::json!({
        "hostId":"host", "revision":"a".repeat(64),
    }))
    .unwrap();
    let result = Preparation::begin(&registry, "request".into(), pending.clone())
        .unwrap()
        .capture(|| live(&pending), async { Ok((42, Some(review))) })
        .await
        .unwrap();
    assert_eq!(result, 42);
    let registered = registry.get("request").unwrap();
    let connection = registered.connection.lock().unwrap();
    assert!(!connection.busy);
    assert_eq!(
        connection.review.as_ref().unwrap().identity(),
        "a".repeat(64)
    );
    assert!(!*pending.cancelled.borrow());
    drop(connection);
    registry.remove("request").unwrap();
    assert!(*pending.cancelled.borrow());
}

#[test]
fn duplicate_request_does_not_cancel_or_modify_the_original_preparation() {
    let registry = Registry::default();
    let original = pending();
    let preparation = Preparation::begin(&registry, "same".into(), original.clone()).unwrap();
    assert!(Preparation::begin(&registry, "same".into(), pending()).is_err());
    assert!(Arc::ptr_eq(&original, &registry.get("same").unwrap()));
    assert!(!*original.cancelled.borrow());
    drop(preparation);
    assert!(registry.get("same").is_err());
}
