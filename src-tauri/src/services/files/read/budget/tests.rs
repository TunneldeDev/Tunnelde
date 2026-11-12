use super::*;
use std::time::Duration;

#[tokio::test]
async fn cancellation_keeps_running_io_charged_until_the_worker_really_exits() {
    let capacity = Arc::new(Semaphore::new(1));
    let (started, waiting) = tokio::sync::oneshot::channel();
    let (release, blocker) = std::sync::mpsc::channel();
    let job = tokio::spawn(run_with(capacity.clone(), move |_| {
        started.send(()).unwrap();
        blocker.recv_timeout(Duration::from_secs(5)).unwrap();
        Ok(())
    }));
    tokio::time::timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap();
    job.abort();
    assert!(job.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert_eq!(
        run_with(capacity.clone(), |_| Ok(()))
            .await
            .unwrap_err()
            .to_string(),
        "fileRead.busy"
    );
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while capacity.available_permits() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    run_with(capacity, |_| Ok(())).await.unwrap();
}

#[test]
fn a_cancelled_queued_job_never_opens_or_reads_a_file() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let capacity = Arc::new(Semaphore::new(1));
        let (started, waiting) = tokio::sync::oneshot::channel();
        let (release, blocker) = std::sync::mpsc::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            started.send(()).unwrap();
            blocker.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        tokio::time::timeout(Duration::from_secs(2), waiting)
            .await
            .unwrap()
            .unwrap();
        let called = Arc::new(AtomicBool::new(false));
        let probe = called.clone();
        let job = tokio::spawn(run_with(capacity.clone(), move |_| {
            probe.store(true, Ordering::Release);
            Ok(())
        }));
        tokio::time::timeout(Duration::from_secs(2), async {
            while capacity.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        job.abort();
        assert!(job.await.unwrap_err().is_cancelled());
        assert_eq!(capacity.available_permits(), 0);
        release.send(()).unwrap();
        blocker.await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while capacity.available_permits() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!called.load(Ordering::Acquire));
        run_with(capacity, |_| Ok(())).await.unwrap();
    });
}

#[tokio::test]
async fn worker_failure_releases_capacity_and_does_not_expose_panic_text() {
    let capacity = Arc::new(Semaphore::new(1));
    let error = run_with::<()>(capacity.clone(), |_| panic!("private worker diagnostic"))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "fileRead.workerFailed");
    run_with(capacity, |_| Ok(())).await.unwrap();
}

#[tokio::test]
async fn a_worker_rechecks_cancellation_after_waiting_for_a_shared_cursor() {
    let capacity = Arc::new(Semaphore::new(1));
    let (started, waiting) = tokio::sync::oneshot::channel();
    let (release, blocker) = std::sync::mpsc::channel();
    let called = Arc::new(AtomicBool::new(false));
    let probe = called.clone();
    let task = tokio::spawn(run_with(capacity.clone(), move |job| {
        started.send(()).unwrap();
        blocker.recv_timeout(Duration::from_secs(5)).unwrap();
        job.check()?;
        probe.store(true, Ordering::Release);
        Ok(())
    }));
    tokio::time::timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while capacity.available_permits() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!called.load(Ordering::Acquire));
}

#[tokio::test]
async fn cancelled_network_work_retains_its_permit_until_the_pending_reply_settles() {
    let capacity = Arc::new(Semaphore::new(1));
    let (started, waiting) = tokio::sync::oneshot::channel();
    let (release, reply) = tokio::sync::oneshot::channel();
    let (finished, complete) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(run_async_with(capacity.clone(), |job| async move {
        started.send(()).unwrap();
        reply.await.unwrap();
        let cancelled = job.check().is_err();
        finished.send(cancelled).unwrap();
        job.check()
    }));
    tokio::time::timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert_eq!(
        run_with(capacity.clone(), |_| Ok(()))
            .await
            .unwrap_err()
            .to_string(),
        "fileRead.busy",
        "Network and blocking readers share actual-worker admission"
    );
    release.send(()).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(2), complete)
        .await
        .unwrap()
        .unwrap());
    tokio::time::timeout(Duration::from_secs(2), async {
        while capacity.available_permits() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    run_async_with(capacity, |_| async { Ok(()) })
        .await
        .unwrap();
}

#[tokio::test]
async fn network_worker_failure_releases_capacity_without_disclosing_panic_payload() {
    let capacity = Arc::new(Semaphore::new(1));
    let error = run_async_with::<(), _, _>(capacity.clone(), |_| async {
        panic!("private network payload");
    })
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "fileRead.workerFailed");
    run_with(capacity, |_| Ok(())).await.unwrap();
}
