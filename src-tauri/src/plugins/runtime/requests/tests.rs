use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[tokio::test]
async fn cancellation_is_owned_and_drops_work_before_reply() {
    let registry = Requests::default();
    registry.reserve("a", "1").unwrap();
    registry.reserve("b", "1").unwrap();
    let mut request = registry.claim("a", "1").unwrap();
    assert!(registry.claim("a", "1").is_err());
    assert!(!registry.cancel("other", "1"));
    let dropped = AtomicBool::new(false);
    struct Dropped<'a>(&'a AtomicBool);
    impl Drop for Dropped<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let marker = Dropped(&dropped);
    let work = async move {
        let _marker = marker;
        std::future::pending::<AppResult<()>>().await
    };
    assert!(registry.cancel("a", "1"));
    assert_eq!(
        request.run(work).await.unwrap_err().to_string(),
        "plugin.api.cancelled"
    );
    assert!(dropped.load(Ordering::SeqCst));
    assert!(registry.claim("b", "1").is_ok());
}

#[test]
fn duplicate_replay_late_drop_and_owner_retirement_are_fenced() {
    let registry = Requests::default();
    registry.reserve("a", "1").unwrap();
    assert!(registry.reserve("a", "1").is_err());
    let old = registry.claim("a", "1").unwrap();
    registry.cancel("a", "1");
    assert!(registry.reserve("a", "1").is_err());
    registry.retire("a");
    registry.reserve("a", "1").unwrap();
    drop(old);
    assert!(registry.claim("a", "1").is_ok());
    registry.reserve("a", "pending").unwrap();
    registry.reserve("b", "pending").unwrap();
    registry.retire("a");
    assert!(registry.claim("a", "pending").is_err());
    assert!(registry.claim("b", "pending").is_ok());
}

#[test]
fn quotas_expiration_and_abandoned_reservations_are_bounded() {
    let registry = Requests::default();
    for owner in ["a", "b"] {
        for id in 0..32 {
            registry.reserve(owner, &id.to_string()).unwrap();
        }
    }
    assert!(registry.reserve("a", "overflow").is_err());
    assert!(registry.reserve("c", "overflow").is_err());
    for entry in registry.inner.lock().unwrap().values() {
        entry.lock().unwrap().deadline = Instant::now();
    }
    assert!(registry.claim("a", "0").is_err());
    registry.reserve("c", "new").unwrap();
    assert_eq!(registry.inner.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn already_completed_effects_are_not_rolled_back_by_cancel() {
    let registry = Requests::default();
    registry.reserve("a", "1").unwrap();
    let mut request = registry.claim("a", "1").unwrap();
    assert_eq!(request.run(async { Ok(42) }).await.unwrap(), 42);
    drop(request);
    assert!(!registry.cancel("a", "1"));
}

#[test]
fn synchronous_fence_observes_cancel_without_polling_the_caller() {
    let registry = Requests::default();
    registry.reserve("a", "1").unwrap();
    let request = registry.claim("a", "1").unwrap();
    let fence = InvocationFence {
        entry: request.entry.clone(),
    };
    assert_eq!(fence.with_live(|| Ok(42)).unwrap(), 42);
    assert!(registry.cancel("a", "1"));
    let result: AppResult<()> = fence.with_live(|| panic!("cancelled invocation must not commit"));
    assert_eq!(result.unwrap_err().to_string(), "plugin.api.cancelled");
}

#[test]
fn synchronous_commit_linearizes_before_concurrent_cancel() {
    let registry = Requests::default();
    registry.reserve("a", "1").unwrap();
    let request = registry.claim("a", "1").unwrap();
    let fence = InvocationFence {
        entry: request.entry.clone(),
    };
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (release, wait_release) = std::sync::mpsc::channel();
    let commit = std::thread::spawn(move || {
        fence.with_live(|| {
            entered.send(()).unwrap();
            wait_release.recv().unwrap();
            Ok(42)
        })
    });
    wait_entered.recv().unwrap();
    let (attempting, wait_attempting) = std::sync::mpsc::channel();
    let (cancelled, wait_cancelled) = std::sync::mpsc::channel();
    let cancellation = std::thread::spawn(move || {
        attempting.send(()).unwrap();
        cancelled.send(registry.cancel("a", "1")).unwrap();
    });
    wait_attempting.recv().unwrap();
    assert!(wait_cancelled.try_recv().is_err());
    release.send(()).unwrap();
    assert_eq!(commit.join().unwrap().unwrap(), 42);
    assert!(wait_cancelled.recv().unwrap());
    cancellation.join().unwrap();
}

#[test]
fn old_fences_cannot_revive_after_drop_retirement_or_id_reuse() {
    let registry = Requests::default();
    registry.reserve("a", "1").unwrap();
    let old = registry.claim("a", "1").unwrap();
    let old_fence = InvocationFence {
        entry: old.entry.clone(),
    };
    drop(old);
    registry.reserve("a", "1").unwrap();
    let replacement = registry.claim("a", "1").unwrap();
    let replacement_fence = InvocationFence {
        entry: replacement.entry.clone(),
    };
    assert!(old_fence.with_live(|| Ok(())).is_err());
    assert!(replacement_fence.with_live(|| Ok(())).is_ok());
    registry.retire("a");
    registry.reserve("a", "1").unwrap();
    let current = registry.claim("a", "1").unwrap();
    drop(replacement);
    assert!(replacement_fence.with_live(|| Ok(())).is_err());
    assert!(InvocationFence {
        entry: current.entry.clone()
    }
    .with_live(|| Ok(()))
    .is_ok());
}

#[tokio::test]
async fn invocation_context_is_scoped_isolated_and_does_not_leak_to_children() {
    let registry = Requests::default();
    registry.reserve("a", "1").unwrap();
    registry.reserve("b", "1").unwrap();
    let mut a = registry.claim("a", "1").unwrap();
    let mut b = registry.claim("b", "1").unwrap();
    assert!(current_invocation_fence().is_none());
    let (a_fence, b_fence) = tokio::join!(
        a.run(async {
            tokio::task::yield_now().await;
            assert!(tokio::spawn(async { current_invocation_fence().is_none() })
                .await
                .unwrap());
            Ok(current_invocation_fence().unwrap())
        }),
        b.run(async {
            tokio::task::yield_now().await;
            Ok(current_invocation_fence().unwrap())
        }),
    );
    assert!(current_invocation_fence().is_none());
    assert!(registry.cancel("a", "1"));
    assert!(a_fence.unwrap().with_live(|| Ok(())).is_err());
    assert!(b_fence.unwrap().with_live(|| Ok(())).is_ok());
}

#[test]
fn synchronous_fence_rechecks_deadline() {
    let registry = Requests::default();
    registry.reserve("a", "1").unwrap();
    let request = registry.claim("a", "1").unwrap();
    let fence = InvocationFence {
        entry: request.entry.clone(),
    };
    request.entry.lock().unwrap().deadline = Instant::now();
    assert!(fence.with_live(|| Ok(())).is_err());
}
