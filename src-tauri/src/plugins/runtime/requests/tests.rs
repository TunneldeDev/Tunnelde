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

#[tokio::test]
async fn retained_admission_waits_for_actual_settlement_after_cancel_and_keeps_id_reserved() {
    let registry = Requests::default();
    registry.reserve("view", "work").unwrap();
    let mut request = registry.claim("view", "work").unwrap();
    let (entered, started) = tokio::sync::oneshot::channel();
    let (finish, finished) = tokio::sync::oneshot::channel();
    let mut task = tokio::spawn(async move {
        request
            .run_retained(async {
                entered.send(()).unwrap();
                finished.await.unwrap();
                Ok("actually finished")
            })
            .await
    });
    started.await.unwrap();
    assert!(registry.cancel("view", "work"));
    assert!(tokio::time::timeout(Duration::from_millis(10), &mut task)
        .await
        .is_err());
    assert!(registry.reserve("view", "work").is_err());
    finish.send(()).unwrap();
    assert!(task.await.unwrap().is_err()); // no late reply after cancellation
    registry.reserve("view", "work").unwrap();
}
#[tokio::test]
async fn retained_admission_never_polls_pre_cancelled_work_and_still_scopes_invocation() {
    let registry = Requests::default();
    registry.reserve("view", "work").unwrap();
    let mut request = registry.claim("view", "work").unwrap();
    assert!(registry.cancel("view", "work"));
    assert!(request
        .run_retained(async {
            panic!("cancelled work must not start");
            #[allow(unreachable_code)]
            Ok(())
        })
        .await
        .is_err());
    drop(request);
    registry.reserve("view", "next").unwrap();
    let mut request = registry.claim("view", "next").unwrap();
    let fence = request
        .run_retained(async { Ok(current_invocation_fence().unwrap()) })
        .await
        .unwrap();
    assert!(current_invocation_fence().is_none());
    drop(request);
    assert!(fence.with_live(|| Ok(())).is_err());
}

#[tokio::test]
async fn consent_cancel_waiter_observes_cancellation_before_or_after_subscription() {
    for already_cancelled in [true, false] {
        let registry = Requests::default();
        registry.reserve("view", "consent").unwrap();
        let request = registry.claim("view", "consent").unwrap();
        let fence = InvocationFence {
            entry: request.entry.clone(),
        };
        if already_cancelled {
            assert!(registry.cancel("view", "consent"));
            tokio::time::timeout(Duration::from_secs(1), fence.cancelled())
                .await
                .unwrap();
        } else {
            let waiter = tokio::spawn(async move { fence.cancelled().await });
            tokio::task::yield_now().await;
            assert!(registry.cancel("view", "consent"));
            tokio::time::timeout(Duration::from_secs(1), waiter)
                .await
                .unwrap()
                .unwrap();
        }
    }
}

#[tokio::test]
async fn consent_cancel_waiter_observes_request_drop_and_expired_deadline() {
    let registry = Requests::default();
    registry.reserve("view", "consent").unwrap();
    let request = registry.claim("view", "consent").unwrap();
    let fence = InvocationFence {
        entry: request.entry.clone(),
    };
    drop(request);
    tokio::time::timeout(Duration::from_secs(1), fence.cancelled())
        .await
        .unwrap();
    registry.reserve("view", "next").unwrap();
    let request = registry.claim("view", "next").unwrap();
    request.entry.lock().unwrap().deadline = Instant::now();
    let fence = InvocationFence {
        entry: request.entry.clone(),
    };
    tokio::time::timeout(Duration::from_secs(1), fence.cancelled())
        .await
        .unwrap();
}

#[tokio::test]
async fn retained_disk_or_keyring_worker_keeps_request_reserved_until_blocking_exit() {
    let registry = Requests::default();
    registry.reserve("view", "persistent-data").unwrap();
    let mut request = registry.claim("view", "persistent-data").unwrap();
    let (started, entered) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let mut task = tokio::spawn(async move {
        request
            .run_retained(async {
                // This matches the audited configuration/credential dispatch:
                // the domain awaits its actual blocking JoinHandle, with no
                // timeout or detached reply hiding a still-running mutation.
                tokio::task::spawn_blocking(move || {
                    started.send(()).unwrap();
                    wait.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(())
                })
                .await
                .unwrap()
            })
            .await
    });
    entered.await.unwrap();
    assert!(registry.cancel("view", "persistent-data"));
    assert!(tokio::time::timeout(Duration::from_millis(10), &mut task)
        .await
        .is_err());
    assert!(registry.reserve("view", "persistent-data").is_err());
    release.send(()).unwrap();
    assert_eq!(
        task.await.unwrap().unwrap_err().to_string(),
        "plugin.api.cancelled"
    );
    registry.reserve("view", "persistent-data").unwrap();
}

#[tokio::test]
async fn retained_unmount_worker_rechecks_the_original_invocation_after_awaiting_probe() {
    for expire in [false, true] {
        let registry = Requests::default();
        registry.reserve("view", "unmount").unwrap();
        let mut request = registry.claim("view", "unmount").unwrap();
        let entry = request.entry.clone();
        let result = request
            .run_retained(crate::mounts::unmount::tests::cancelled_invocation(
                move || {
                    if expire {
                        entry.lock().unwrap().deadline = Instant::now();
                    } else {
                        assert!(registry.cancel("view", "unmount"));
                    }
                },
            ))
            .await;
        assert_eq!(result.unwrap_err().to_string(), "plugin.api.cancelled");
    }
}

#[tokio::test]
async fn force_stop_rejects_cancelled_or_expired_admission_but_always_settles_admitted_host_intent()
{
    for expire in [false, true] {
        for before_commit in [false, true] {
            let registry = Requests::default();
            registry.reserve("view", "force").unwrap();
            let mut request = registry.claim("view", "force").unwrap();
            let entry = request.entry.clone();
            let result = request
                .run_retained(crate::mounts::unmount::tests::force_invocation(
                    move || {
                        if expire {
                            entry.lock().unwrap().deadline = Instant::now();
                        } else {
                            assert!(registry.cancel("view", "force"));
                        }
                    },
                    before_commit,
                ))
                .await;
            // Result delivery is cancelled in both cases; the helper asserts
            // original intent before admission and settled stop intent after it.
            assert_eq!(result.unwrap_err().to_string(), "plugin.api.cancelled");
        }
    }
}

#[tokio::test]
async fn remote_mount_reads_recheck_real_invocation_cancel_and_expiry_after_stat() {
    use crate::{
        services::operations::WorkLifetime,
        ssh::files::directory::{self, tests::fixture::Fixture, Query},
    };
    use tokio::sync::oneshot;
    struct Retained(Option<oneshot::Sender<()>>);
    impl Drop for Retained {
        fn drop(&mut self) {
            let _ = self.0.take().unwrap().send(());
        }
    }
    for kind in 0..3 {
        for expired in [false, true] {
            let fixture = Fixture::new().await;
            fixture.seen.delay_stat.store(true, Ordering::SeqCst);
            fixture.seen.hold_close.store(true, Ordering::SeqCst);
            let registry = Requests::default();
            registry.reserve("plugin", "remote-read").unwrap();
            let mut request = registry.claim("plugin", "remote-read").unwrap();
            let entry = request.entry.clone();
            let handle = fixture.handle.clone();
            let (fence_done, mut done) = oneshot::channel();
            let task = tokio::spawn(WorkLifetime::new(Retained(Some(fence_done))).scope(
                async move {
                    request
                        .run_retained(async {
                            let fence = current_invocation_fence().unwrap();
                            directory::query(
                                handle,
                                match kind {
                                    0 => Query::Resolve { path: None },
                                    1 => Query::Browse {
                                        path: None,
                                        offset: 0,
                                    },
                                    _ => Query::LegacyBrowse { path: "/".into() },
                                },
                                move || fence.with_live(|| Ok(())),
                            )
                            .await
                        })
                        .await
                },
            ));
            tokio::time::timeout(Duration::from_secs(3), fixture.seen.stat.notified())
                .await
                .unwrap();
            if expired {
                entry.lock().unwrap().deadline = Instant::now();
            } else {
                assert!(registry.cancel("plugin", "remote-read"));
            }
            fixture.seen.delay_stat.store(false, Ordering::SeqCst);
            fixture.seen.release_stat.notify_one();
            tokio::time::timeout(
                Duration::from_secs(3),
                fixture.seen.close_received.notified(),
            )
            .await
            .unwrap();
            assert!(
                !task.is_finished(),
                "cleanup must await the actual peer CLOSE"
            );
            assert!(done.try_recv().is_err());
            assert_eq!(fixture.seen.reads.load(Ordering::SeqCst), 0);
            fixture.seen.hold_close.store(false, Ordering::SeqCst);
            fixture.seen.release_close.notify_one();
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(3), task)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap_err()
                    .to_string(),
                "plugin.api.cancelled"
            );
            tokio::time::timeout(Duration::from_secs(3), done)
                .await
                .unwrap()
                .unwrap();
            directory::query(
                fixture.handle.clone(),
                Query::Resolve { path: None },
                || Ok(()),
            )
            .await
            .unwrap();
            assert!(!fixture.handle.is_closed());
        }
    }
}

#[tokio::test]
async fn legacy_conversion_fences_cancel_and_expiry_but_finishes_already_committed_adoption() {
    for expire in [false, true] {
        for before_commit in [false, true] {
            let registry = Requests::default();
            registry.reserve("view", "adoption").unwrap();
            let mut request = registry.claim("view", "adoption").unwrap();
            let entry = request.entry.clone();
            let result = request
                .run_retained(crate::mounts::adoption::tests::persistence::invocation(
                    move || {
                        if expire {
                            entry.lock().unwrap().deadline = Instant::now();
                        } else {
                            assert!(registry.cancel("view", "adoption"));
                        }
                    },
                    before_commit,
                ))
                .await;
            assert_eq!(result.unwrap_err().to_string(), "plugin.api.cancelled");
        }
    }
}

#[tokio::test]
async fn managed_open_rechecks_original_invocation_before_launch_and_retains_admitted_os_work() {
    for expire in [false, true] {
        for before_commit in [false, true] {
            let registry = Requests::default();
            registry.reserve("view", "mount-open").unwrap();
            let mut request = registry.claim("view", "mount-open").unwrap();
            let entry = request.entry.clone();
            let result = request
                .run_retained(crate::mounts::managed::tests::invocation(
                    move || {
                        if expire {
                            entry.lock().unwrap().deadline = Instant::now();
                        } else {
                            assert!(registry.cancel("view", "mount-open"));
                        }
                    },
                    before_commit,
                ))
                .await;
            assert_eq!(result.unwrap_err().to_string(), "plugin.api.cancelled");
        }
    }
}

#[tokio::test]
async fn one_off_open_keeps_original_invocation_across_workers_and_admitted_launch() {
    for expire in [false, true] {
        for before_commit in [false, true] {
            let registry = Requests::default();
            registry.reserve("view", "one-off-open").unwrap();
            let mut request = registry.claim("view", "one-off-open").unwrap();
            let entry = request.entry.clone();
            let result = request
                .run_retained(crate::mounts::managed::tests::plugin_invocation(
                    move || {
                        if expire {
                            entry.lock().unwrap().deadline = Instant::now();
                        } else {
                            assert!(registry.cancel("view", "one-off-open"));
                        }
                    },
                    before_commit,
                ))
                .await;
            assert_eq!(result.unwrap_err().to_string(), "plugin.api.cancelled");
        }
    }
}

#[tokio::test]
async fn mount_documentation_fences_original_request_and_retains_an_admitted_browser_launch() {
    for expire in [false, true] {
        for before_commit in [false, true] {
            let registry = Requests::default();
            registry.reserve("view", "mount-documentation").unwrap();
            let mut request = registry.claim("view", "mount-documentation").unwrap();
            let entry = request.entry.clone();
            let result = request
                .run_retained(crate::mounts::documentation::tests::invocation(
                    move || {
                        if expire {
                            entry.lock().unwrap().deadline = Instant::now();
                        } else {
                            assert!(registry.cancel("view", "mount-documentation"));
                        }
                    },
                    before_commit,
                ))
                .await;
            assert_eq!(result.unwrap_err().to_string(), "plugin.api.cancelled");
        }
    }
}
