//! Simulated browser launch: these prove admission/lifetime, not an actual OS browser.
use super::*;
use crate::{error::AppError, services::operations::WorkLifetime};
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

#[test]
fn documentation_is_a_fixed_host_link_not_a_dependency_probe() {
    let expected = if cfg!(windows) {
        "https://github.com/winfsp/sshfs-win"
    } else {
        "https://github.com/libfuse/sshfs"
    };
    assert_eq!(url(), expected);
}

#[tokio::test]
async fn revoked_read_grant_never_launches() {
    let granted = Arc::new(AtomicBool::new(true));
    let check = granted.clone();
    let admission = Admission::capture(move || {
        if check.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(AppError::validation("revoked"))
        }
    });
    granted.store(false, Ordering::Release);
    let opened = Arc::new(AtomicBool::new(false));
    let did_open = opened.clone();
    let result = run(&Budget::new(1, ERRORS), admission, move || {
        did_open.store(true, Ordering::Release);
        Ok(())
    })
    .await;
    assert_eq!(result.unwrap_err().to_string(), "revoked");
    assert!(!opened.load(Ordering::Acquire));
}

#[tokio::test]
async fn aborted_delivery_retains_capacity_and_native_effect_through_actual_opener_return() {
    let capacity = Arc::new(Semaphore::new(1));
    let budget = Arc::new(Budget::with_capacity(capacity.clone(), ERRORS));
    let worker = budget.clone();
    let (entered, ready) = oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (settled, mut done) = oneshot::channel();
    let task = tokio::spawn(WorkLifetime::new(Fence(Some(settled))).scope(async move {
        run(&worker, Admission::capture(|| Ok(())), move || {
            entered.send(()).unwrap();
            wait.recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            Err(AppError::validation("opener.failed"))
        })
        .await
    }));
    ready.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert!(done.try_recv().is_err());
    assert_eq!(
        budget.blocking(|_| Ok(())).await.unwrap_err().to_string(),
        "mounts.operations.busy"
    );
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), done)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(capacity.available_permits(), 1);
}

pub(crate) async fn invocation(cancel: impl FnOnce(), before_commit: bool) -> AppResult<()> {
    let admission = Admission::capture(|| Ok(()));
    let opened = Arc::new(AtomicBool::new(false));
    let did_open = opened.clone();
    let result = if before_commit {
        // Capture the original fence, then cancel it before worker admission.
        cancel();
        run(&Budget::new(1, ERRORS), admission, move || {
            did_open.store(true, Ordering::Release);
            Ok(())
        })
        .await
    } else {
        let (entered, ready) = oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let task = tokio::spawn(async move {
            run(&Budget::new(1, ERRORS), admission, move || {
                did_open.store(true, Ordering::Release);
                entered.send(()).unwrap();
                wait.recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                Ok(())
            })
            .await
        });
        ready.await.unwrap();
        cancel();
        assert!(!task.is_finished());
        release.send(()).unwrap();
        task.await.unwrap()
    };
    assert_eq!(opened.load(Ordering::Acquire), !before_commit);
    if before_commit {
        assert_eq!(result.unwrap_err().to_string(), "plugin.api.cancelled");
    } else {
        result?;
    }
    Ok(())
}
