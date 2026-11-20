use super::*;
use crate::services::operations::WorkLifetime;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::{oneshot, Semaphore};
struct Fence(Option<oneshot::Sender<()>>);
impl Drop for Fence {
    fn drop(&mut self) {
        let _ = self.0.take().unwrap().send(());
    }
}

#[tokio::test]
async fn timed_out_filesystem_worker_keeps_capacity_and_native_effect_until_actual_return() {
    let capacity = Arc::new(Semaphore::new(1));
    let budget = Arc::new(Budget::with_capacity(capacity.clone(), ERRORS));
    let (entered, ready) = oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (settled, mut done) = oneshot::channel();
    let worker = budget.clone();
    let task = tokio::spawn(WorkLifetime::new(Fence(Some(settled))).scope(async move {
        bounded(&worker, Duration::from_secs(1), move |cancel| {
            entered.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            cancel.check()?;
            Ok(())
        })
        .await
    }));
    ready.await.unwrap();
    assert_eq!(
        task.await.unwrap().unwrap_err().to_string(),
        "mounts.pathTimeout"
    );
    assert_eq!(capacity.available_permits(), 0);
    assert!(done.try_recv().is_err());
    assert_eq!(
        budget.blocking(|_| Ok(())).await.unwrap_err().to_string(),
        "mounts.pathBusy"
    );
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), done)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(capacity.available_permits(), 1);
}
#[tokio::test]
async fn cancelled_compatibility_opener_retains_effect_and_suppresses_late_launch() {
    let (entered, ready) = oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (settled, mut done) = oneshot::channel();
    let opened = Arc::new(AtomicBool::new(false));
    let did_open = opened.clone();
    let task = tokio::spawn(
        WorkLifetime::new(Fence(Some(settled))).scope(cancellable_open(move |allowed| {
            entered.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            if allowed.load(Ordering::Acquire) {
                did_open.store(true, Ordering::Release);
            }
            Ok(())
        })),
    );
    ready.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(done.try_recv().is_err());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), done)
        .await
        .unwrap()
        .unwrap();
    assert!(!opened.load(Ordering::Acquire));
}
