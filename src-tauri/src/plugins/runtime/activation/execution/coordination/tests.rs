use super::*;
use crate::plugins::{Instance, PluginStatus};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::sync::{oneshot, Notify};

fn key(generation: usize) -> Key {
    Key {
        id: "sample".into(),
        stamp: format!("boot:{generation}"),
        fingerprint: "a".repeat(64),
    }
}

fn info() -> PluginInfo {
    let manifest = serde_json::from_value(serde_json::json!({
        "id":"sample", "name":"Sample", "version":"1.0.0", "apiVersion":1,
        "runtime":"declarative"
    }))
    .unwrap();
    let mut instance = Instance::new(manifest, PathBuf::new());
    instance.status = PluginStatus::Running;
    instance.runtime_id = Some("boot:1".into());
    instance.info()
}

async fn drain() {
    for _ in 0..12 {
        tokio::task::yield_now().await;
    }
}

fn unreachable_work() -> impl Future<Output = AppResult<PluginInfo>> {
    panic!("coalesced or rejected work must never run");
    #[allow(unreachable_code)]
    async {
        Ok(info())
    }
}

async fn unreachable_settle(_: bool) -> AppResult<()> {
    panic!("coalesced or rejected settlement must never run");
}

#[tokio::test]
async fn coalesces_one_runtime_without_merging_generations_or_factories() {
    let starts = Coordinator::new();
    let (release, wait) = oneshot::channel();
    let settled = Arc::new(AtomicUsize::new(0));
    let count = settled.clone();
    let first = starts
        .join(
            key(1),
            || async {
                wait.await.unwrap();
                Ok(info())
            },
            move |success| async move {
                assert!(success);
                count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap();
    let second = starts
        .join(key(1), unreachable_work, unreachable_settle)
        .unwrap();
    let replacement = starts
        .join(key(2), || async { Ok(info()) }, |_| async { Ok(()) })
        .unwrap();
    assert_eq!(replacement.wait().await.unwrap().id, "sample");
    assert_eq!(starts.entries.lock().unwrap().len(), 1);
    release.send(()).unwrap();
    let (first, second) = tokio::join!(first.wait(), second.wait());
    assert_eq!(first.unwrap().runtime_id, second.unwrap().runtime_id);
    assert_eq!(settled.load(Ordering::SeqCst), 1);
    assert!(starts.entries.lock().unwrap().is_empty());
    assert_eq!(starts.waiters.available_permits(), MAX_WAITERS);
}

#[tokio::test]
async fn cancellation_is_per_waiter_until_the_last_unfinished_ticket_leaves() {
    let starts = Coordinator::new();
    let work = Arc::new(Notify::new());
    let waiting = work.clone();
    let settled = Arc::new(AtomicUsize::new(0));
    let count = settled.clone();
    let first = starts
        .join(
            key(1),
            move || async move {
                waiting.notified().await;
                Ok(info())
            },
            move |success| async move {
                assert!(success);
                count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap();
    let second = starts
        .join(key(1), unreachable_work, unreachable_settle)
        .unwrap();
    drain().await;
    drop(first);
    drain().await;
    assert_eq!(settled.load(Ordering::SeqCst), 0);
    assert!(!*starts
        .entries
        .lock()
        .unwrap()
        .get(&key(1))
        .unwrap()
        .cancelled
        .borrow());
    work.notify_one();
    second.wait().await.unwrap();
    assert_eq!(settled.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn last_waiter_cancels_work_and_holds_its_slot_until_cleanup_really_settles() {
    let starts = Coordinator::new();
    let (entered, cleanup) = oneshot::channel();
    let (release, exit) = oneshot::channel();
    let ticket = starts
        .join(key(1), std::future::pending, move |success| async move {
            assert!(!success);
            entered.send(()).unwrap();
            exit.await.unwrap();
            Ok(())
        })
        .unwrap();
    drop(ticket);
    cleanup.await.unwrap();
    assert_eq!(starts.entries.lock().unwrap().len(), 1);
    assert_eq!(
        starts
            .join(key(1), unreachable_work, unreachable_settle)
            .err()
            .unwrap()
            .to_string(),
        "pluginSecurity.changed"
    );
    // A replacement is a different operation; old cleanup cannot own its slot.
    let replacement = starts
        .join(key(2), std::future::pending, |_| async { Ok(()) })
        .unwrap();
    release.send(()).unwrap();
    drain().await;
    assert!(!starts.entries.lock().unwrap().contains_key(&key(1)));
    assert!(starts.entries.lock().unwrap().contains_key(&key(2)));
    drop(replacement);
    drain().await;
    assert!(starts.entries.lock().unwrap().is_empty());
}

#[tokio::test]
async fn bounds_unfinished_operations_even_during_cleanup_and_releases_settled_capacity() {
    let starts = Coordinator::new();
    let cleanup = Arc::new(Notify::new());
    let mut tickets = Vec::new();
    for generation in 0..MAX_STARTS {
        let cleanup = cleanup.clone();
        tickets.push(
            starts
                .join(key(generation), std::future::pending, move |_| async move {
                    cleanup.notified().await;
                    Ok(())
                })
                .unwrap(),
        );
    }
    assert_eq!(
        starts
            .join(key(MAX_STARTS), unreachable_work, unreachable_settle)
            .err()
            .unwrap()
            .to_string(),
        "plugin.api.busy"
    );
    drop(tickets);
    drain().await;
    assert_eq!(
        starts
            .join(key(MAX_STARTS), unreachable_work, unreachable_settle)
            .err()
            .unwrap()
            .to_string(),
        "plugin.api.busy"
    );
    cleanup.notify_waiters();
    drain().await;
    assert!(starts.entries.lock().unwrap().is_empty());
    starts
        .join(
            key(MAX_STARTS),
            || async { Ok(info()) },
            |_| async { Ok(()) },
        )
        .unwrap()
        .wait()
        .await
        .unwrap();
}

#[tokio::test]
async fn enforces_per_operation_and_global_ticket_bounds_without_running_rejected_factories() {
    let starts = Coordinator::new();
    let mut tickets = Vec::new();
    for group in 0..MAX_WAITERS / MAX_WAITERS_PER_START {
        tickets.push(
            starts
                .join(key(group), std::future::pending, |_| async { Ok(()) })
                .unwrap(),
        );
        for _ in 1..MAX_WAITERS_PER_START {
            tickets.push(
                starts
                    .join(key(group), unreachable_work, unreachable_settle)
                    .unwrap(),
            );
        }
        assert_eq!(
            starts
                .join(key(group), unreachable_work, unreachable_settle)
                .err()
                .unwrap()
                .to_string(),
            "plugin.api.busy"
        );
    }
    assert_eq!(starts.waiters.available_permits(), 0);
    assert_eq!(
        starts
            .join(key(100), unreachable_work, unreachable_settle)
            .err()
            .unwrap()
            .to_string(),
        "plugin.api.busy"
    );
    drop(tickets.pop());
    let replacement = starts
        .join(key(7), unreachable_work, unreachable_settle)
        .unwrap();
    drop(replacement);
    drop(tickets);
    drain().await;
    assert_eq!(starts.waiters.available_permits(), MAX_WAITERS);
    assert!(starts.entries.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn deadline_is_absolute_and_new_waiters_cannot_extend_it() {
    let starts = Coordinator::new();
    let first = starts
        .join(key(1), std::future::pending, |success| async move {
            assert!(!success);
            Ok(())
        })
        .unwrap();
    drain().await;
    tokio::time::advance(std::time::Duration::from_secs(44)).await;
    let second = starts
        .join(key(1), unreachable_work, unreachable_settle)
        .unwrap();
    tokio::time::advance(std::time::Duration::from_secs(1)).await;
    assert_eq!(
        first.wait().await.unwrap_err().to_string(),
        "plugin.timeout"
    );
    assert_eq!(
        second.wait().await.unwrap_err().to_string(),
        "plugin.timeout"
    );
    assert!(starts.entries.lock().unwrap().is_empty());
}

#[tokio::test]
async fn work_panics_settle_and_cleanup_panics_quarantine_the_operation() {
    let starts = Coordinator::new();
    let panic = starts
        .join(key(1), unreachable_work, |success| async move {
            assert!(!success);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        panic.wait().await.unwrap_err().to_string(),
        "plugin.activation.failed"
    );
    assert!(starts.entries.lock().unwrap().is_empty());
    let cleanup = starts
        .join(key(1), || async { Ok(info()) }, unreachable_settle)
        .unwrap();
    assert_eq!(
        cleanup.wait().await.unwrap_err().to_string(),
        "plugin.activation.cleanupFailed"
    );
    assert_eq!(starts.entries.lock().unwrap().len(), 1);
    assert_eq!(
        starts
            .join(key(1), unreachable_work, unreachable_settle)
            .err()
            .unwrap()
            .to_string(),
        "pluginSecurity.changed"
    );
    assert_eq!(starts.waiters.available_permits(), MAX_WAITERS);
}

#[tokio::test]
async fn shared_detailed_errors_survive_failed_cleanup_and_late_subscribers() {
    let starts = Coordinator::new();
    let first = starts
        .join(
            key(1),
            || async {
                Err(AppError::PluginUiSdkUnsupported {
                    required: "2".into(),
                    available: "1".into(),
                })
            },
            |_| async { Err(AppError::internal("cleanup failed")) },
        )
        .unwrap();
    let second = starts
        .join(key(1), unreachable_work, unreachable_settle)
        .unwrap();
    drain().await;
    let first = first.wait().await.unwrap_err();
    let second = second.wait().await.unwrap_err();
    assert!(matches!(
        first.original(),
        AppError::PluginUiSdkUnsupported { .. }
    ));
    assert_eq!(
        serde_json::to_value(first).unwrap(),
        serde_json::to_value(second).unwrap()
    );
    assert_eq!(starts.entries.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn cancel_all_interrupts_waiters_and_still_settles_each_operation() {
    let starts = Coordinator::new();
    let ticket = starts
        .join(key(1), std::future::pending, |success| async move {
            assert!(!success);
            Ok(())
        })
        .unwrap();
    starts.cancel_all();
    assert_eq!(
        ticket.wait().await.unwrap_err().to_string(),
        "pluginSecurity.changed"
    );
    assert!(starts.entries.lock().unwrap().is_empty());
}
