use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::Semaphore;

#[tokio::test(flavor = "current_thread")]
async fn platform_work_leaves_the_runtime_thread_free_and_preserves_errors() {
    let budget = Arc::new(Budget::new(1, ERRORS));
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let owner_thread = std::thread::current().id();
    let owned = budget.clone();
    let request = tokio::spawn(async move {
        run(&owned, move || -> AppResult<()> {
            started.send(std::thread::current().id()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            Err(AppError::Ssh("vault.load: native failure".into()))
        })
        .await
    });
    let worker_thread = tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(worker_thread, owner_thread);
    // The platform fixture is still waiting; a single runtime thread can run
    // another request and a timer before it completes. No actual keyring here.
    tokio::time::timeout(Duration::from_secs(2), async {
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(1)).await;
    })
    .await
    .unwrap();
    release.send(()).unwrap();
    assert_eq!(
        request.await.unwrap().unwrap_err().to_string(),
        "vault.load: native failure"
    );
}

#[tokio::test]
async fn losing_the_caller_keeps_capacity_until_the_admitted_worker_settles() {
    let capacity = Arc::new(Semaphore::new(1));
    let budget = Arc::new(Budget::with_capacity(capacity.clone(), ERRORS));
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let owned = budget.clone();
    let request = tokio::spawn(async move {
        run(&owned, move || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        })
        .await
    });
    ready.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert_eq!(
        run(&budget, || Ok(())).await.unwrap_err().to_string(),
        "credentials.busy"
    );
    release.send(()).unwrap();
    wait_for_capacity(&capacity).await;
    run(&budget, || Ok(())).await.unwrap();
}

#[test]
fn a_cancelled_queued_request_cannot_start_a_late_platform_mutation() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        ready.await.unwrap();
        let capacity = Arc::new(Semaphore::new(1));
        let budget = Arc::new(Budget::with_capacity(capacity.clone(), ERRORS));
        let mutated = Arc::new(AtomicBool::new(false));
        let owned = budget.clone();
        let changed = mutated.clone();
        let request = tokio::spawn(async move {
            run(&owned, move || {
                changed.store(true, Ordering::Release);
                Ok(())
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while capacity.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert_eq!(capacity.available_permits(), 0);
        release.send(()).unwrap();
        blocker.await.unwrap();
        wait_for_capacity(&capacity).await;
        assert!(!mutated.load(Ordering::Acquire));
        run(&budget, || Ok(())).await.unwrap();
    });
}

async fn wait_for_capacity(capacity: &Semaphore) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while capacity.available_permits() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
