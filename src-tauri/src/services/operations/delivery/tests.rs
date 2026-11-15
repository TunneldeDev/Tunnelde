use super::*;
use crate::error::AppResult;
use crate::services::operations::{Budget, Errors};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

const ERRORS: Errors = Errors {
    domain: "delivery-test",
    busy: "busy",
    cancelled: "cancelled",
    failed: "failed",
};

#[test]
fn accepting_transfers_ownership_and_only_unreceived_values_are_disposed() {
    let cleanups = Arc::new(AtomicUsize::new(0));
    let observed = cleanups.clone();
    let accepted = Delivery::new("accepted session", move |_| {
        observed.fetch_add(1, Ordering::AcqRel);
    });
    assert_eq!(accepted.accept(), "accepted session");
    assert_eq!(cleanups.load(Ordering::Acquire), 0);
    let observed = cleanups.clone();
    drop(Delivery::new("undelivered session", move |id| {
        assert_eq!(*id, "undelivered session");
        observed.fetch_add(1, Ordering::AcqRel);
    }));
    assert_eq!(cleanups.load(Ordering::Acquire), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn cancellation_after_admission_disposes_the_resource_created_by_a_detached_worker() {
    let budget = Arc::new(Budget::new(1, ERRORS));
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (disposed, disposal) = tokio::sync::oneshot::channel();
    let request = tokio::spawn(async move {
        let delivery = budget
            .blocking(move |job| {
                job.commit()?;
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(Delivery::new("new session", move |id| {
                    disposed.send(*id).unwrap();
                }))
            })
            .await?;
        Ok::<_, crate::error::AppError>(delivery.accept())
    });
    ready.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), disposal)
            .await
            .unwrap()
            .unwrap(),
        "new session"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn abandoning_an_unpolled_worker_result_also_disposes_its_resource() {
    use std::future::{poll_fn, Future};
    use std::task::Poll;

    let budget = Budget::new(1, ERRORS);
    let (release, wait) = std::sync::mpsc::channel();
    let (finished, completion) = tokio::sync::oneshot::channel();
    let (disposed, disposal) = tokio::sync::oneshot::channel();
    let mut request = Box::pin(budget.blocking(move |job| -> AppResult<_> {
        job.commit()?;
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        let value = Delivery::new("queued result", move |id| {
            disposed.send(*id).unwrap();
        });
        finished.send(()).unwrap();
        Ok(value)
    }));
    poll_fn(|cx| {
        assert!(request.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    release.send(()).unwrap();
    completion.await.unwrap();
    drop(request);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), disposal)
            .await
            .unwrap()
            .unwrap(),
        "queued result"
    );
}
