use super::*;
use crate::services::operations::WorkLifetime;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{oneshot, Semaphore};

struct Exit(Arc<AtomicBool>);
impl Drop for Exit {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}
async fn registry() -> (MountRegistry, Arc<AtomicBool>) {
    let mut cmd = if cfg!(windows) {
        let mut cmd = command("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 60",
        ]);
        cmd
    } else {
        let mut cmd = command("sh");
        cmd.args(["-c", "exec sleep 60"]);
        cmd
    };
    let child = cmd.kill_on_drop(true).spawn().unwrap();
    let settled = Arc::new(AtomicBool::new(false));
    let exit = Exit(settled.clone());
    let (entered, ready) = oneshot::channel();
    let bridge = tokio::spawn(async move {
        let _exit = exit;
        entered.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    ready.await.unwrap();
    let registry = MountRegistry::default();
    registry.mounts.lock().await.insert(
        "mount".into(),
        ActiveMount {
            info: MountInfo {
                id: "mount".into(),
                owner: "owner".into(),
                session_id: "session".into(),
                remote_path: "/qa".into(),
                mount_point: "/never-a-real-mount".into(),
                read_only: true,
                cleanup_error: None,
            },
            generation: 7,
            child,
            bridge,
            bridge_joined: false,
            #[cfg(windows)]
            device_mapping: None,
            #[cfg(target_os = "linux")]
            mount_id: None,
            #[cfg(target_os = "macos")]
            mount_device: None,
        },
    );
    (registry, settled)
}
fn request() -> Request {
    Request {
        owner: "owner".into(),
        id: "mount".into(),
        force: false,
        generation: Some(7),
    }
}
fn budget() -> (Budget, Arc<Semaphore>) {
    let capacity = Arc::new(Semaphore::new(1));
    (
        Budget::with_capacity(
            capacity.clone(),
            Errors {
                domain: "test.unmount",
                busy: "busy",
                cancelled: "cancelled",
                failed: "failed",
            },
        ),
        capacity,
    )
}
struct Gate {
    entered: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    release: std::sync::Mutex<Option<oneshot::Receiver<()>>>,
}
impl Gate {
    fn new() -> (Self, oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (entered, ready) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        (
            Self {
                entered: std::sync::Mutex::new(Some(entered)),
                release: std::sync::Mutex::new(Some(wait)),
            },
            ready,
            release,
        )
    }
    async fn wait(&self) {
        let wait = self.release.lock().unwrap().take().unwrap();
        self.entered
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(())
            .unwrap();
        wait.await.unwrap();
    }
}
struct Simulated {
    probe: Option<Gate>,
    dismount: Option<Gate>,
    writes: Arc<AtomicBool>,
    matches: bool,
}
impl Effects for Simulated {
    async fn present(&self, _: &ActiveMount) -> AppResult<bool> {
        if let Some(probe) = &self.probe {
            probe.wait().await;
        }
        Ok(true)
    }
    async fn matches(&self, _: &ActiveMount) -> AppResult<bool> {
        Ok(self.matches)
    }
    async fn dismount(&self, _: &ActiveMount, _: bool) -> AppResult<Option<std::fs::File>> {
        self.writes.store(true, Ordering::SeqCst);
        if let Some(dismount) = &self.dismount {
            dismount.wait().await;
        }
        Ok(None)
    }
}
struct Fence(Option<oneshot::Sender<()>>);
impl Drop for Fence {
    fn drop(&mut self) {
        let _ = self.0.take().unwrap().send(());
    }
}
async fn cleanup(registry: &MountRegistry) {
    let mut mounts = registry.mounts.lock().await;
    if let Some(active) = mounts.get_mut("mount") {
        lifecycle::settle_process(active).await.unwrap();
    }
    mounts.clear();
}
#[tokio::test]
async fn cancelled_admitted_transaction_keeps_lock_and_effect_through_real_worker_settlement() {
    let (registry, settled) = registry().await;
    let mounts = registry.mounts.clone().lock_owned().await;
    let (budget, capacity) = budget();
    let (gate, ready, release) = Gate::new();
    let (fence, completed) = oneshot::channel();
    let writes = Arc::new(AtomicBool::new(false));
    let effects = Simulated {
        probe: None,
        dismount: Some(gate),
        writes: writes.clone(),
        matches: true,
    };
    let caller = tokio::spawn(WorkLifetime::new(Fence(Some(fence))).scope(async move {
        run_with_budget(
            &budget,
            mounts,
            request(),
            Admission::capture(|| Ok(())),
            effects,
        )
        .await
    }));
    ready.await.unwrap(); // After the real admission, before dismount returns.
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(writes.load(Ordering::SeqCst));
    assert!(!settled.load(Ordering::SeqCst));
    assert_eq!(capacity.available_permits(), 0);
    assert!(registry.mounts.try_lock().is_err());
    assert!(tokio::time::timeout(
        std::time::Duration::ZERO,
        registry.adopt_managed::<()>(
            "mount".into(),
            (),
            |_, _| panic!("adoption overtook dismount"),
            |_, _| {}
        )
    )
    .await
    .is_err());
    assert!(tokio::time::timeout(
        std::time::Duration::ZERO,
        registry.unmount("owner", "mount", false)
    )
    .await
    .is_err());
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), completed)
        .await
        .unwrap()
        .unwrap();
    assert!(settled.load(Ordering::SeqCst)); // Actual owned bridge was joined.
    assert_eq!(capacity.available_permits(), 1);
    assert!(registry.mounts.lock().await.is_empty());
}
#[tokio::test]
async fn cancelled_delivery_before_commit_leaves_the_original_mount_untouched() {
    let (registry, settled) = registry().await;
    let mounts = registry.mounts.clone().lock_owned().await;
    let (budget, capacity) = budget();
    let (gate, ready, release) = Gate::new();
    let (fence, completed) = oneshot::channel();
    let writes = Arc::new(AtomicBool::new(false));
    let effects = Simulated {
        probe: Some(gate),
        dismount: None,
        writes: writes.clone(),
        matches: true,
    };
    let caller = tokio::spawn(WorkLifetime::new(Fence(Some(fence))).scope(async move {
        run_with_budget(
            &budget,
            mounts,
            request(),
            Admission::capture(|| Ok(())),
            effects,
        )
        .await
    }));
    ready.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(registry.mounts.try_lock().is_err());
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), completed)
        .await
        .unwrap()
        .unwrap();
    assert!(!writes.load(Ordering::SeqCst));
    assert!(!settled.load(Ordering::SeqCst));
    assert_eq!(capacity.available_permits(), 1);
    assert!(registry
        .mounts
        .lock()
        .await
        .get_mut("mount")
        .unwrap()
        .child
        .try_wait()
        .unwrap()
        .is_none());
    cleanup(&registry).await;
}
#[tokio::test]
async fn policy_revoked_during_probe_and_changed_mount_identity_never_admit_a_dismount() {
    for revoked in [true, false] {
        let (registry, settled) = registry().await;
        let mounts = registry.mounts.clone().lock_owned().await;
        let (budget, _) = budget();
        let (gate, ready, release) = Gate::new();
        let writes = Arc::new(AtomicBool::new(false));
        let live = Arc::new(AtomicBool::new(true));
        let admission_live = live.clone();
        let effects = Simulated {
            probe: Some(gate),
            dismount: None,
            writes: writes.clone(),
            matches: revoked,
        };
        let task = tokio::spawn(async move {
            run_with_budget(
                &budget,
                mounts,
                request(),
                Admission::capture(move || {
                    if admission_live.load(Ordering::SeqCst) {
                        Ok(())
                    } else {
                        Err(AppError::validation("revoked"))
                    }
                }),
                effects,
            )
            .await
        });
        ready.await.unwrap();
        if revoked {
            live.store(false, Ordering::SeqCst);
        }
        release.send(()).unwrap();
        assert_eq!(
            task.await.unwrap().unwrap_err().to_string(),
            if revoked {
                "revoked"
            } else {
                "mounts.mountPoint.changed"
            }
        );
        assert!(!writes.load(Ordering::SeqCst));
        assert!(!settled.load(Ordering::SeqCst));
        cleanup(&registry).await;
    }
}
/// Called from the actual request-registry fixture while its invocation task
/// local is scoped. The owned worker must use the captured fence, not an empty
/// task local in the newly spawned task.
pub(crate) async fn cancelled_invocation(cancel: impl FnOnce()) -> AppResult<()> {
    let (registry, settled) = registry().await;
    let mounts = registry.mounts.clone().lock_owned().await;
    let (budget, _) = budget();
    let (gate, ready, release) = Gate::new();
    let writes = Arc::new(AtomicBool::new(false));
    let effects = Simulated {
        probe: Some(gate),
        dismount: None,
        writes: writes.clone(),
        matches: true,
    };
    let admission = Admission::capture(|| Ok(()));
    assert!(admission.invocation.is_some());
    let task = tokio::spawn(async move {
        run_with_budget(&budget, mounts, request(), admission, effects).await
    });
    ready.await.unwrap();
    cancel();
    release.send(()).unwrap();
    assert_eq!(
        task.await.unwrap().unwrap_err().to_string(),
        "plugin.api.cancelled"
    );
    assert!(!writes.load(Ordering::SeqCst));
    assert!(!settled.load(Ordering::SeqCst));
    cleanup(&registry).await;
    Ok(())
}

#[tokio::test]
async fn outer_timeout_cannot_release_an_admitted_dismount_or_its_mount_record() {
    let (registry, settled) = registry().await;
    let mounts = registry.mounts.clone().lock_owned().await;
    let (budget, capacity) = budget();
    let (gate, ready, release) = Gate::new();
    let (drop_waiter, dropped) = oneshot::channel();
    let (fence, completed) = oneshot::channel();
    let effects = Simulated {
        probe: None,
        dismount: Some(gate),
        writes: Arc::new(AtomicBool::new(false)),
        matches: true,
    };
    let caller = tokio::spawn(WorkLifetime::new(Fence(Some(fence))).scope(async move {
        let work = run_with_budget(
            &budget,
            mounts,
            request(),
            Admission::capture(|| Ok(())),
            effects,
        );
        tokio::pin!(work);
        tokio::select! {
            biased;
            _ = dropped => {},
            result = &mut work => panic!("unmount settled before test deadline: {result:?}"),
        }
        // This is precisely the outer-timeout boundary in stop_resource.
        assert!(tokio::time::timeout(std::time::Duration::ZERO, &mut work)
            .await
            .is_err());
    }));
    ready.await.unwrap();
    drop_waiter.send(()).unwrap();
    caller.await.unwrap();
    assert_eq!(capacity.available_permits(), 0);
    assert!(registry.mounts.try_lock().is_err());
    assert!(!settled.load(Ordering::SeqCst));
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), completed)
        .await
        .unwrap()
        .unwrap();
    assert!(settled.load(Ordering::SeqCst));
    assert!(registry.mounts.lock().await.is_empty());
}

#[cfg(unix)]
struct RealHelper {
    entered: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    release: std::sync::Mutex<Option<oneshot::Receiver<()>>>,
    reaped: Arc<AtomicBool>,
}
#[cfg(unix)]
impl Effects for RealHelper {
    async fn present(&self, _: &ActiveMount) -> AppResult<bool> {
        Ok(true)
    }
    async fn matches(&self, _: &ActiveMount) -> AppResult<bool> {
        Ok(true)
    }
    async fn dismount(&self, _: &ActiveMount, _: bool) -> AppResult<Option<std::fs::File>> {
        let mut child = command("/bin/sh")
            .args(["-c", "exec sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let wait = self.release.lock().unwrap().take().unwrap();
        self.entered
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(())
            .unwrap();
        wait.await.unwrap();
        let error = helper::collect(
            &mut child,
            std::time::Duration::ZERO,
            1024,
            "helper-expired",
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "helper-expired");
        assert!(child.id().is_none());
        assert!(child.try_wait()?.is_some());
        self.reaped.store(true, Ordering::SeqCst);
        // Mimic the production reconciliation only after successful absence
        // confirmation. No real mount/dismount is performed by this fixture.
        Ok(None)
    }
}
#[cfg(unix)]
#[tokio::test]
async fn cancelled_transaction_does_not_release_the_map_before_its_real_helper_is_reaped() {
    let (registry, settled) = registry().await;
    let mounts = registry.mounts.clone().lock_owned().await;
    let (budget, capacity) = budget();
    let (entered, ready) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    let (fence, completed) = oneshot::channel();
    let reaped = Arc::new(AtomicBool::new(false));
    let effects = RealHelper {
        entered: std::sync::Mutex::new(Some(entered)),
        release: std::sync::Mutex::new(Some(wait)),
        reaped: reaped.clone(),
    };
    let caller = tokio::spawn(WorkLifetime::new(Fence(Some(fence))).scope(async move {
        run_with_budget(
            &budget,
            mounts,
            request(),
            Admission::capture(|| Ok(())),
            effects,
        )
        .await
    }));
    ready.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(!reaped.load(Ordering::SeqCst));
    assert!(!settled.load(Ordering::SeqCst));
    assert!(registry.mounts.try_lock().is_err());
    assert_eq!(capacity.available_permits(), 0);
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), completed)
        .await
        .unwrap()
        .unwrap();
    assert!(reaped.load(Ordering::SeqCst));
    assert!(settled.load(Ordering::SeqCst));
    assert!(registry.mounts.lock().await.is_empty());
}

struct FailedDismount;
impl Effects for FailedDismount {
    async fn present(&self, _: &ActiveMount) -> AppResult<bool> {
        Ok(true)
    }
    async fn matches(&self, _: &ActiveMount) -> AppResult<bool> {
        Ok(true)
    }
    async fn dismount(&self, _: &ActiveMount, _: bool) -> AppResult<Option<std::fs::File>> {
        Err(AppError::validation("mounts.busy"))
    }
}
#[tokio::test]
async fn failed_dismount_keeps_the_owned_record_and_live_transport_for_safe_retry() {
    let (registry, settled) = registry().await;
    let (budget, capacity) = budget();
    let result = run_with_budget(
        &budget,
        registry.mounts.clone().lock_owned().await,
        request(),
        Admission::capture(|| Ok(())),
        FailedDismount,
    )
    .await;
    assert_eq!(result.unwrap_err().to_string(), "mounts.busy");
    assert_eq!(capacity.available_permits(), 1);
    assert!(!settled.load(Ordering::SeqCst));
    let mut mounts = registry.mounts.lock().await;
    let active = mounts.get_mut("mount").unwrap();
    assert_eq!(active.info.owner, "owner");
    assert_eq!(active.generation, 7);
    assert!(active.child.try_wait().unwrap().is_none());
    drop(mounts);
    cleanup(&registry).await;
}

#[tokio::test]
async fn force_stop_keeps_group_and_host_intent_until_cleanup_after_caller_and_grant_are_gone() {
    use crate::services::mounts::runtime::{force::tests::worker_policy, Coordinator};
    let (registry, settled) = registry().await;
    let mounts = registry.mounts.clone().lock_owned().await;
    let runtime = Arc::new(Coordinator::default());
    let granted = Arc::new(AtomicBool::new(true));
    let policy = worker_policy(
        runtime.clone(),
        granted.clone(),
        runtime.gate("group").unwrap(),
    );
    let (budget, _) = budget();
    let (gate, ready, release) = Gate::new();
    let (fence, completed) = oneshot::channel();
    let effects = Simulated {
        probe: None,
        dismount: Some(gate),
        writes: Arc::new(AtomicBool::new(false)),
        matches: true,
    };
    let caller = tokio::spawn(WorkLifetime::new(Fence(Some(fence))).scope(async move {
        run_with_budget(
            &budget,
            mounts,
            Request {
                force: true,
                ..request()
            },
            Admission::capture(policy),
            effects,
        )
        .await
    }));
    ready.await.unwrap();
    assert!(!runtime.rule_states()[0].desired);
    granted.store(false, Ordering::Release);
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(runtime.gate("group").is_err());
    assert!(registry.mounts.try_lock().is_err());
    assert!(!settled.load(Ordering::Acquire));
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), completed)
        .await
        .unwrap()
        .unwrap();
    assert!(runtime.gate("group").is_ok());
    let state = &runtime.rule_states()[0];
    assert_eq!(state.phase, "stopped");
    assert!(!state.desired);
    assert!(state.runtime_id.is_none() && state.session_id.is_none());
    assert!(registry.mounts.lock().await.is_empty());
    assert!(settled.load(Ordering::Acquire));
}
#[tokio::test]
async fn force_stop_rejected_before_admission_preserves_intent_and_original_worker() {
    use crate::services::mounts::runtime::{force::tests::worker_policy, Coordinator};
    for revoke in [false, true] {
        let (registry, settled) = registry().await;
        let mounts = registry.mounts.clone().lock_owned().await;
        let runtime = Arc::new(Coordinator::default());
        let granted = Arc::new(AtomicBool::new(true));
        let policy = worker_policy(
            runtime.clone(),
            granted.clone(),
            runtime.gate("group").unwrap(),
        );
        let (budget, _) = budget();
        let (gate, ready, release) = Gate::new();
        let (fence, completed) = oneshot::channel();
        let writes = Arc::new(AtomicBool::new(false));
        let effects = Simulated {
            probe: Some(gate),
            dismount: None,
            writes: writes.clone(),
            matches: true,
        };
        let caller = tokio::spawn(WorkLifetime::new(Fence(Some(fence))).scope(async move {
            run_with_budget(
                &budget,
                mounts,
                Request {
                    force: true,
                    ..request()
                },
                Admission::capture(policy),
                effects,
            )
            .await
        }));
        ready.await.unwrap();
        if revoke {
            granted.store(false, Ordering::Release);
        } else {
            caller.abort();
            assert!(caller.await.unwrap_err().is_cancelled());
        }
        release.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), completed)
            .await
            .unwrap()
            .unwrap();
        assert!(runtime.gate("group").is_ok());
        assert!(runtime.rule_states()[0].desired);
        assert_eq!(
            runtime.rule_states()[0].runtime_id.as_deref(),
            Some("mount")
        );
        assert!(!writes.load(Ordering::Acquire) && !settled.load(Ordering::Acquire));
        cleanup(&registry).await;
    }
}
#[tokio::test]
async fn force_stop_failure_keeps_reservation_but_never_requests_automatic_remount() {
    use crate::services::mounts::runtime::{force::tests::worker_policy, Coordinator};
    let (registry, settled) = registry().await;
    let runtime = Arc::new(Coordinator::default());
    let granted = Arc::new(AtomicBool::new(true));
    let policy = worker_policy(runtime.clone(), granted, runtime.gate("group").unwrap());
    let (budget, _) = budget();
    let result = run_with_budget(
        &budget,
        registry.mounts.clone().lock_owned().await,
        Request {
            force: true,
            ..request()
        },
        Admission::capture(policy),
        FailedDismount,
    )
    .await;
    assert_eq!(result.unwrap_err().to_string(), "mounts.busy");
    assert!(runtime.gate("group").is_ok());
    let state = &runtime.rule_states()[0];
    assert_eq!(state.phase, "cleanupRequired");
    assert!(!state.desired);
    assert_eq!(state.runtime_id.as_deref(), Some("mount"));
    assert_eq!(state.session_id.as_deref(), Some("session"));
    assert!(state.error.is_some());
    assert!(!settled.load(Ordering::Acquire));
    cleanup(&registry).await;
}

pub(crate) async fn force_invocation(cancel: impl FnOnce(), before_commit: bool) -> AppResult<()> {
    use crate::services::mounts::runtime::{force::tests::worker_policy, Coordinator};
    let (registry, settled) = registry().await;
    let mounts = registry.mounts.clone().lock_owned().await;
    let runtime = Arc::new(Coordinator::default());
    let policy = worker_policy(
        runtime.clone(),
        Arc::new(AtomicBool::new(true)),
        runtime.gate("group").unwrap(),
    );
    let (budget, _) = budget();
    let (gate, ready, release) = Gate::new();
    let writes = Arc::new(AtomicBool::new(false));
    let (probe, dismount) = if before_commit {
        (Some(gate), None)
    } else {
        (None, Some(gate))
    };
    let effects = Simulated {
        probe,
        dismount,
        writes: writes.clone(),
        matches: true,
    };
    let admission = Admission::capture(policy);
    assert!(admission.invocation.is_some());
    let task = tokio::spawn(async move {
        run_with_budget(
            &budget,
            mounts,
            Request {
                force: true,
                ..request()
            },
            admission,
            effects,
        )
        .await
    });
    ready.await.unwrap();
    cancel();
    release.send(()).unwrap();
    let outcome = task.await.unwrap();
    if before_commit {
        assert_eq!(outcome.unwrap_err().to_string(), "plugin.api.cancelled");
        assert!(runtime.rule_states()[0].desired);
        assert!(!writes.load(Ordering::Acquire) && !settled.load(Ordering::Acquire));
        cleanup(&registry).await;
    } else {
        outcome.unwrap();
        assert_eq!(runtime.rule_states()[0].phase, "stopped");
        assert!(!runtime.rule_states()[0].desired);
        assert!(registry.mounts.lock().await.is_empty());
        assert!(settled.load(Ordering::Acquire));
    }
    Ok(())
}
