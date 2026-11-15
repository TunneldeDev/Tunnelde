use super::*;
use std::{sync::atomic::Ordering, time::Duration};
mod fixture;
use fixture::Fixture;

fn deadline() -> Duration {
    Duration::from_secs(3)
}
fn cancellation() -> (budget::Cancellation, impl Drop) {
    budget::Cancellation::for_test("fileRead.cancelled")
}
fn start(
    f: &Fixture,
    capacity: &Arc<Semaphore>,
    job: budget::Cancellation,
    timeout: Duration,
) -> tokio::task::JoinHandle<AppResult<(RemoteReader, u64)>> {
    let handle = f.handle.clone();
    let permit = capacity.clone().try_acquire_owned().unwrap();
    tokio::spawn(async move {
        RemoteReader::open_on(handle, "/source.bin".into(), &job, permit, timeout).await
    })
}
fn error(result: AppResult<(RemoteReader, u64)>) -> String {
    match result {
        Ok(_) => panic!("unexpected opened reader"),
        Err(error) => error.to_string(),
    }
}

#[tokio::test]
async fn accepted_reader_transfers_capacity_and_preserves_read_only_io() {
    Fixture::new(false).await.read().await;
}

#[tokio::test]
async fn rejected_subsystem_reclaims_capacity_and_preserves_parent() {
    let f = Fixture::new(false).await;
    f.seen.reject.store(true, Ordering::SeqCst);
    let capacity = Arc::new(Semaphore::new(1));
    assert_ne!(error(f.open(&capacity).await), "sftp.transferTimedOut");
    tokio::time::timeout(deadline(), async {
        while capacity.available_permits() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    f.seen.reject.store(false, Ordering::SeqCst);
    f.read().await;
}

#[tokio::test]
async fn open_timeout_retains_capacity_until_late_close_without_subsystem() {
    let f = Fixture::new(true).await;
    let capacity = Arc::new(Semaphore::new(1));
    let (job, _pending) = cancellation();
    let call = start(&f, &capacity, job, Duration::from_millis(150));
    tokio::time::timeout(deadline(), f.seen.opened.notified())
        .await
        .unwrap();
    assert_eq!(error(call.await.unwrap()), "sftp.transferTimedOut");
    assert_eq!(capacity.available_permits(), 0);
    assert!(capacity.clone().try_acquire_owned().is_err());
    f.release().await;
    f.settled(&capacity).await;
    assert_eq!(f.seen.subsystems.load(Ordering::SeqCst), 0);
    f.read().await;
}

#[tokio::test]
async fn aborted_open_closes_late_channel_without_subsystem() {
    let f = Fixture::new(true).await;
    let capacity = Arc::new(Semaphore::new(1));
    let (job, _pending) = cancellation();
    let call = start(&f, &capacity, job, deadline());
    tokio::time::timeout(deadline(), f.seen.opened.notified())
        .await
        .unwrap();
    call.abort();
    assert!(call.await.err().unwrap().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    f.release().await;
    f.settled(&capacity).await;
    assert_eq!(f.seen.subsystems.load(Ordering::SeqCst), 0);
    f.read().await;
}

#[tokio::test]
async fn cancelled_worker_rejects_confirmed_channel_before_subsystem() {
    let f = Fixture::new(true).await;
    let capacity = Arc::new(Semaphore::new(1));
    let (job, pending) = cancellation();
    let call = start(&f, &capacity, job, deadline());
    tokio::time::timeout(deadline(), f.seen.opened.notified())
        .await
        .unwrap();
    drop(pending);
    f.release().await;
    assert_eq!(error(call.await.unwrap()), "fileRead.cancelled");
    f.settled(&capacity).await;
    assert_eq!(f.seen.subsystems.load(Ordering::SeqCst), 0);
    f.read().await;
}

#[tokio::test]
async fn already_cancelled_worker_submits_no_open() {
    let f = Fixture::new(false).await;
    let capacity = Arc::new(Semaphore::new(1));
    let (job, pending) = cancellation();
    drop(pending);
    assert_eq!(
        error(start(&f, &capacity, job, deadline()).await.unwrap()),
        "fileRead.cancelled"
    );
    assert_eq!(capacity.available_permits(), 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), f.seen.opened.notified())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn parent_disposal_reclaims_retired_pending_open() {
    let f = Fixture::new(true).await;
    let capacity = Arc::new(Semaphore::new(1));
    let (job, _pending) = cancellation();
    let call = start(&f, &capacity, job, deadline());
    tokio::time::timeout(deadline(), f.seen.opened.notified())
        .await
        .unwrap();
    call.abort();
    assert!(call.await.err().unwrap().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    f.handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .unwrap();
    tokio::time::timeout(deadline(), async {
        while capacity.available_permits() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(f.seen.subsystems.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn stalled_negotiation_timeout_retires_only_reader_channel() {
    let f = Fixture::new(false).await;
    f.seen.stall.store(true, Ordering::SeqCst);
    let capacity = Arc::new(Semaphore::new(1));
    let (job, _pending) = cancellation();
    let call = start(&f, &capacity, job, Duration::from_millis(150));
    tokio::time::timeout(deadline(), f.seen.subsystem.notified())
        .await
        .unwrap();
    assert_eq!(error(call.await.unwrap()), "sftp.transferTimedOut");
    f.settled(&capacity).await;
    f.seen.stall.store(false, Ordering::SeqCst);
    f.read().await;
}

#[tokio::test]
async fn aborted_negotiation_closes_channel_and_preserves_parent() {
    let f = Fixture::new(false).await;
    f.seen.stall.store(true, Ordering::SeqCst);
    let capacity = Arc::new(Semaphore::new(1));
    let (job, _pending) = cancellation();
    let call = start(&f, &capacity, job, deadline());
    tokio::time::timeout(deadline(), f.seen.subsystem.notified())
        .await
        .unwrap();
    call.abort();
    assert!(call.await.err().unwrap().is_cancelled());
    f.settled(&capacity).await;
    f.seen.stall.store(false, Ordering::SeqCst);
    f.read().await;
}
