use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::oneshot;
pub(crate) mod fixture;
use fixture::Fixture;
fn browse(offset: usize) -> Query {
    Query::Browse {
        path: Some("~/source".into()),
        offset,
    }
}
fn cancellation() -> (Cancellation, impl Drop) {
    Cancellation::for_test("cancelled")
}
async fn call(f: &Fixture, query: Query) -> AppResult<Value> {
    call_with_deadline(f, query, Duration::from_secs(3)).await
}
async fn call_with_deadline(f: &Fixture, query: Query, deadline: Duration) -> AppResult<Value> {
    let (cancel, _pending) = cancellation();
    let capacity = Arc::new(Semaphore::new(1));
    tokio::time::timeout(
        deadline + Duration::from_secs(5),
        on(
            f.handle.clone(),
            query,
            || Ok(()),
            cancel,
            capacity.clone().try_acquire_owned().unwrap(),
            deadline,
        ),
    )
    .await
    .expect("directory query failed to settle")
}
#[tokio::test]
async fn real_sftp_reads_are_directory_only_sorted_paged_and_parent_stays_usable() {
    let f = Fixture::new().await;
    for offset in [0, 128, 256, usize::MAX] {
        let value = tokio::time::timeout(Duration::from_secs(5), call(&f, browse(offset)))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(value["path"], "/home/qa/source");
        let entries = value["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 261usize.saturating_sub(offset).min(128));
        if offset == 0 {
            assert_eq!(entries[0]["name"], ".hidden");
            assert_eq!(entries[1]["name"], "dir-000");
            assert_eq!(entries[1]["modified"], 100000);
        }
        assert!(entries.iter().all(|e| e["isDir"] == true));
        assert_eq!(
            value["nextOffset"],
            if offset < 256 {
                json!(offset + 128)
            } else {
                Value::Null
            }
        );
        assert!(!f.handle.is_closed());
    }
    let resolved = call(&f, Query::Resolve { path: None }).await.unwrap();
    assert_eq!(resolved, json!({"home":"/home/qa","path":"/home/qa"}));
    assert_eq!(f.seen.handles_closed.load(Ordering::SeqCst), 4);
}
#[tokio::test]
async fn invalid_and_hostile_replies_fail_closed_without_losing_the_parent() {
    let f = Fixture::new().await;
    f.seen.invalid_name.store(true, Ordering::SeqCst);
    assert_eq!(
        call(&f, browse(0)).await.unwrap_err().to_string(),
        "fileRead.invalidReply"
    );
    f.seen.invalid_name.store(false, Ordering::SeqCst);
    f.seen.flood.store(true, Ordering::SeqCst);
    assert_eq!(
        // Reading 65K entries should test the size bound, not race a much
        // shorter test-only deadline while the full suite saturates the CPU.
        call_with_deadline(&f, browse(0), DEADLINE)
            .await
            .unwrap_err()
            .to_string(),
        "mounts.remoteListingTooLarge"
    );
    f.seen.flood.store(false, Ordering::SeqCst);
    f.seen.stat_is_file.store(true, Ordering::SeqCst);
    assert_eq!(
        call(&f, Query::Resolve { path: None })
            .await
            .unwrap_err()
            .to_string(),
        "plugin.tools.invalidPath"
    );
    f.seen.stat_is_file.store(false, Ordering::SeqCst);
    call(&f, browse(0)).await.unwrap();
    assert!(!f.handle.is_closed());
}
#[tokio::test]
async fn invalid_request_and_cancelled_admission_never_open_an_ssh_channel() {
    let f = Fixture::new().await;
    for path in ["bad\0path".into(), "bad\npath".into(), "x".repeat(2049)] {
        assert!(call(&f, Query::Resolve { path: Some(path) }).await.is_err());
    }
    let (cancel, pending) = cancellation();
    drop(pending);
    let permit = Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap();
    assert_eq!(
        on(
            f.handle.clone(),
            browse(0),
            || Ok(()),
            cancel,
            permit,
            Duration::from_secs(3)
        )
        .await
        .unwrap_err()
        .to_string(),
        "cancelled"
    );
    assert_eq!(f.seen.opens.load(Ordering::SeqCst), 0);
}
struct Fence(Option<oneshot::Sender<()>>);
impl Drop for Fence {
    fn drop(&mut self) {
        let _ = self.0.take().unwrap().send(());
    }
}
#[tokio::test]
async fn timed_out_or_cancelled_pending_open_keeps_capacity_and_effect_until_late_channel_retirement(
) {
    for abort in [false, true] {
        let f = Fixture::new().await;
        f.seen.hold.store(true, Ordering::SeqCst);
        let capacity = Arc::new(Semaphore::new(1));
        let permit = capacity.clone().try_acquire_owned().unwrap();
        let (cancel, _pending) = cancellation();
        let (fence, mut done) = oneshot::channel();
        let handle = f.handle.clone();
        let task = tokio::spawn(WorkLifetime::new(Fence(Some(fence))).scope(async move {
            on(
                handle,
                browse(0),
                || Ok(()),
                cancel,
                permit,
                Duration::from_millis(80),
            )
            .await
        }));
        tokio::time::timeout(Duration::from_secs(3), f.seen.opened.notified())
            .await
            .unwrap();
        if abort {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            assert_eq!(
                task.await.unwrap().unwrap_err().to_string(),
                "mounts.pathTimeout"
            );
        }
        assert_eq!(capacity.available_permits(), 0);
        assert!(done.try_recv().is_err());
        f.release().await;
        f.settled(&capacity).await;
        tokio::time::timeout(Duration::from_secs(3), done)
            .await
            .unwrap()
            .unwrap();
        assert!(!f.handle.is_closed());
        call(&f, Query::Resolve { path: None }).await.unwrap();
    }
}
#[tokio::test]
async fn subsystem_reject_or_stall_retires_only_the_query_channel() {
    for stall in [false, true] {
        let f = Fixture::new().await;
        f.seen.reject.store(!stall, Ordering::SeqCst);
        f.seen.stall.store(stall, Ordering::SeqCst);
        let capacity = Arc::new(Semaphore::new(1));
        let (cancel, _pending) = cancellation();
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            on(
                f.handle.clone(),
                browse(0),
                || Ok(()),
                cancel,
                capacity.clone().try_acquire_owned().unwrap(),
                Duration::from_millis(80),
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            result.unwrap_err().to_string(),
            if stall {
                "mounts.pathTimeout"
            } else {
                "mounts.subsystemRejected"
            }
        );
        f.settled(&capacity).await;
        assert!(!f.handle.is_closed());
        f.seen.reject.store(false, Ordering::SeqCst);
        f.seen.stall.store(false, Ordering::SeqCst);
        call(&f, browse(0)).await.unwrap();
    }
}
#[tokio::test]
async fn revoke_during_stat_cannot_deliver_resolved_data_or_begin_listing() {
    for resolve in [false, true] {
        let f = Fixture::new().await;
        f.seen.delay_stat.store(true, Ordering::SeqCst);
        let granted = Arc::new(AtomicBool::new(true));
        let grant = granted.clone();
        let (cancel, _pending) = cancellation();
        let handle = f.handle.clone();
        let capacity = Arc::new(Semaphore::new(1));
        let permit = capacity.clone().try_acquire_owned().unwrap();
        let task = tokio::spawn(async move {
            on(
                handle,
                if resolve {
                    Query::Resolve { path: None }
                } else {
                    browse(0)
                },
                move || {
                    if grant.load(Ordering::SeqCst) {
                        Ok(())
                    } else {
                        Err(AppError::validation("revoked"))
                    }
                },
                cancel,
                permit,
                Duration::from_secs(3),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(3), f.seen.stat.notified())
            .await
            .unwrap();
        granted.store(false, Ordering::SeqCst);
        f.seen.release_stat.notify_one();
        assert_eq!(task.await.unwrap().unwrap_err().to_string(), "revoked");
        f.settled(&capacity).await;
        assert_eq!(f.seen.reads.load(Ordering::SeqCst), 0);
        assert!(!f.handle.is_closed());
    }
}

#[tokio::test]
async fn cancelled_finish_keeps_channel_and_effect_until_actual_close_ack() {
    let f = Fixture::new().await;
    f.seen.hold_close.store(true, Ordering::SeqCst);
    let capacity = Arc::new(Semaphore::new(1));
    let permit = capacity.clone().try_acquire_owned().unwrap();
    let (cancel, _pending) = cancellation();
    let (fence, mut done) = oneshot::channel();
    let handle = f.handle.clone();
    let task = tokio::spawn(WorkLifetime::new(Fence(Some(fence))).scope(async move {
        on(
            handle,
            browse(0),
            || Ok(()),
            cancel,
            permit,
            Duration::from_secs(3),
        )
        .await
    }));
    tokio::time::timeout(Duration::from_secs(3), f.seen.close_received.notified())
        .await
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert!(done.try_recv().is_err());
    f.seen.hold_close.store(false, Ordering::SeqCst);
    f.seen.release_close.notify_one();
    f.settled(&capacity).await;
    tokio::time::timeout(Duration::from_secs(3), done)
        .await
        .unwrap()
        .unwrap();
    call(&f, Query::Resolve { path: None }).await.unwrap();
    assert!(!f.handle.is_closed());
}

#[tokio::test]
async fn cancelled_delivery_during_sftp_read_retains_nested_workers_until_cleanup() {
    let f = Fixture::new().await;
    f.seen.delay_stat.store(true, Ordering::SeqCst);
    f.seen.hold_close.store(true, Ordering::SeqCst);
    let budget = Arc::new(Budget::new(1, ERRORS));
    let capacity = Arc::new(Semaphore::new(1));
    let permit = capacity.clone().try_acquire_owned().unwrap();
    let (fence, mut done) = oneshot::channel();
    let handle = f.handle.clone();
    let worker_budget = budget.clone();
    let task = tokio::spawn(WorkLifetime::new(Fence(Some(fence))).scope(async move {
        worker_budget
            .asynchronous(move |cancel| async move {
                on(
                    handle,
                    browse(0),
                    || Ok(()),
                    cancel,
                    permit,
                    Duration::from_secs(3),
                )
                .await
            })
            .await
    }));
    tokio::time::timeout(Duration::from_secs(3), f.seen.stat.notified())
        .await
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(done.try_recv().is_err());
    assert_eq!(capacity.available_permits(), 0);
    assert_eq!(
        budget
            .asynchronous(|_| async { Ok(()) })
            .await
            .unwrap_err()
            .to_string(),
        "mounts.pathBusy"
    );
    f.seen.delay_stat.store(false, Ordering::SeqCst);
    f.seen.release_stat.notify_one();
    tokio::time::timeout(Duration::from_secs(3), f.seen.close_received.notified())
        .await
        .unwrap();
    assert!(done.try_recv().is_err());
    assert_eq!(capacity.available_permits(), 0);
    f.seen.hold_close.store(false, Ordering::SeqCst);
    f.seen.release_close.notify_one();
    tokio::time::timeout(Duration::from_secs(3), done)
        .await
        .unwrap()
        .unwrap();
    f.settled(&capacity).await;
    budget.asynchronous(|_| async { Ok(()) }).await.unwrap();
    assert_eq!(f.seen.reads.load(Ordering::SeqCst), 0);
    call(&f, Query::Resolve { path: None }).await.unwrap();
}

#[test]
fn pagination_caps_actual_json_bytes_and_advances_without_skipping() {
    fn entry(name: String, path: String) -> FileEntry {
        FileEntry {
            name,
            path,
            is_dir: true,
            is_hidden: false,
            size: 0,
            modified: None,
            permissions: None,
        }
    }
    let path = format!("/{}", "a".repeat(32000));
    let entries = (0..100)
        .map(|i| entry(i.to_string(), format!("{path}/{i}")))
        .collect();
    let page = page(entries, &path, 0).unwrap();
    assert!(serde_json::to_vec(&page).unwrap().len() <= 512 * 1024);
    let count = page["entries"].as_array().unwrap().len();
    assert!(count > 0 && count < 100);
    assert_eq!(page["nextOffset"], count);
    assert_eq!(page["entries"][count - 1]["name"], (count - 1).to_string());
    let entries = (0..100)
        .map(|i| entry(i.to_string(), format!("{path}/{i}")))
        .collect();
    let next = super::page(entries, &path, count).unwrap();
    assert_eq!(next["entries"][0]["name"], count.to_string());
    // Raw UTF-8 length is not a safe upper bound for escaped JSON strings.
    assert_eq!(
        super::page(vec![entry("\u{1}".repeat(100000), "/p".into())], "/", 0)
            .unwrap_err()
            .to_string(),
        "mounts.remoteListingTooLarge"
    );
    assert_eq!(
        super::page(vec![], "/", usize::MAX).unwrap()["nextOffset"],
        Value::Null
    );
}

#[test]
fn canonical_windows_drive_aliases_keep_the_mount_sftp_namespace() {
    for (raw, expected) in [
        ("C:/qa-home", "/C:/qa-home"),
        ("d:/", "/d:/"),
        ("/C:/qa-home", "/C:/qa-home"),
        ("/home/qa", "/home/qa"),
    ] {
        assert_eq!(canonical_path(raw.into()).unwrap(), expected);
    }
    for raw in [
        "C:relative",
        "relative",
        "C:\\qa-home",
        "bad\0path",
        "/bad\npath",
    ] {
        assert!(canonical_path(raw.into()).is_err(), "{raw:?}");
    }
}
