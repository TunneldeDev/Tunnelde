use super::*;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

struct Settled(Option<tokio::sync::oneshot::Sender<()>>);
impl Drop for Settled {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn slow_secret_access_leaves_runtime_free_and_preserves_platform_failure() {
    let owner = std::thread::current().id();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let request = tokio::spawn(run(
        |job| job.commit(),
        move || -> AppResult<()> {
            started.send(std::thread::current().id()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            Err(AppError::Ssh(
                "vault.save: controlled platform failure".into(),
            ))
        },
    ));
    assert_ne!(ready.await.unwrap(), owner);
    tokio::time::timeout(Duration::from_secs(2), async {
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(1)).await;
    })
    .await
    .unwrap();
    release.send(()).unwrap();
    assert_eq!(
        request.await.unwrap().unwrap_err().to_string(),
        "vault.save: controlled platform failure"
    );
}

#[tokio::test]
async fn revoked_runtime_cannot_enter_the_platform_store() {
    let calls = Arc::new(AtomicUsize::new(0));
    let invoked = calls.clone();
    let error = run(
        |_| Err(AppError::validation("pluginSecurity.changed")),
        move || {
            invoked.fetch_add(1, Ordering::AcqRel);
            Ok(())
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "pluginSecurity.changed");
    assert_eq!(calls.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn cancelling_while_authorization_waits_cannot_start_a_late_secret_write() {
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let changed = Arc::new(AtomicBool::new(false));
    let mutation = changed.clone();
    let (settled, finished) = tokio::sync::oneshot::channel();
    let completion = Settled(Some(settled));
    let request = tokio::spawn(run(
        move |job| {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            job.commit()
        },
        move || {
            let _completion = completion;
            mutation.store(true, Ordering::Release);
            Ok(())
        },
    ));
    ready.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    // Dropping the operation proves the original worker has finished even when
    // cancellation prevented the operation closure from being called.
    tokio::time::timeout(Duration::from_secs(2), finished)
        .await
        .unwrap()
        .unwrap();
    assert!(!changed.load(Ordering::Acquire));
}

#[test]
fn abandoned_queued_secret_write_does_not_run_after_blocking_pool_recovers() {
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
        let changed = Arc::new(AtomicBool::new(false));
        let mutation = changed.clone();
        let (queued, observed) = tokio::sync::oneshot::channel();
        let request = tokio::spawn(async move {
            tokio::select! {
                biased;
                result = run(|job| job.commit(), move || {
                    mutation.store(true, Ordering::Release); Ok(())
                }) => result,
                () = async {
                    queued.send(()).unwrap();
                    std::future::pending().await
                } => unreachable!(),
            }
        });
        observed.await.unwrap();
        assert!(!request.is_finished());
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        release.send(()).unwrap();
        blocker.await.unwrap();
        // A subsequent job on the sole worker proves the cancelled job settled.
        tokio::task::spawn_blocking(|| {}).await.unwrap();
        assert!(!changed.load(Ordering::Acquire));
    });
}

#[tokio::test]
async fn admitted_secret_write_settles_when_reply_delivery_is_abandoned() {
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (settled, finished) = tokio::sync::oneshot::channel();
    let changed = Arc::new(AtomicBool::new(false));
    let mutation = changed.clone();
    let request = tokio::spawn(run(
        |job| job.commit(),
        move || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            mutation.store(true, Ordering::Release);
            settled.send(()).unwrap();
            Ok(())
        },
    ));
    ready.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), finished)
        .await
        .unwrap()
        .unwrap();
    assert!(changed.load(Ordering::Acquire));
}
