//! Real owned registry/ordinary child with simulated OS probes/opening, never
//! physical FUSE or an actual Finder/Explorer launch.
use super::*;
use crate::mounts::adoption::tests::{cleanup, fixture};
use crate::services::{
    mounts::{
        contract::{Entry, Rule},
        runtime::{force::Target, Coordinator},
    },
    operations::WorkLifetime,
};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::oneshot;

struct Fence(Option<oneshot::Sender<()>>);
impl Drop for Fence {
    fn drop(&mut self) {
        let _ = self.0.take().unwrap().send(());
    }
}
struct Gate {
    entered: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    wait: std::sync::Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}
impl Gate {
    fn new() -> (Self, oneshot::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (entered, ready) = oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        (
            Self {
                entered: std::sync::Mutex::new(Some(entered)),
                wait: std::sync::Mutex::new(Some(wait)),
            },
            ready,
            release,
        )
    }
    fn block(&self) {
        let wait = self.wait.lock().unwrap().take().unwrap();
        self.entered
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(())
            .unwrap();
        wait.recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
    }
}
struct Simulated {
    probe: Option<Gate>,
    open: Option<Gate>,
    opened: Arc<AtomicBool>,
    probes: AtomicUsize,
    fail: bool,
    probe_timeout: bool,
}
impl Effects for Simulated {
    async fn probe(&self, _: &ActiveMount) -> AppResult<()> {
        if self.probes.fetch_add(1, Ordering::SeqCst) == 0 {
            if let Some(gate) = &self.probe {
                // Use the real retained blocking worker for a slow filesystem
                // probe, not a blocking sleep on the async runtime thread.
                let wait = gate.wait.lock().unwrap().take().unwrap();
                let entered = gate.entered.lock().unwrap().take().unwrap();
                let deadline = if self.probe_timeout {
                    std::time::Duration::from_secs(1)
                } else {
                    std::time::Duration::from_secs(5)
                };
                let worker = Budget::new(1, ERRORS);
                filesystem::bounded(&worker, deadline, move |cancel| {
                    entered.send(()).unwrap();
                    wait.recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    cancel.check()
                })
                .await?;
            }
        }
        Ok(())
    }
    async fn resolve(&self, _: &MountInfo, relative: PathBuf) -> AppResult<PathBuf> {
        Ok(PathBuf::from("/simulated").join(relative))
    }
    fn open(&self, _: PathBuf, _: bool) -> AppResult<()> {
        self.opened.store(true, Ordering::Release);
        if let Some(gate) = &self.open {
            gate.block();
        }
        if self.fail {
            Err(AppError::validation("opener.failed"))
        } else {
            Ok(())
        }
    }
}
struct TestPolicy {
    runtime: Arc<Coordinator>,
    target: Target,
    granted: Arc<AtomicBool>,
    _group: tokio::sync::OwnedMutexGuard<()>,
}
impl Policy for TestPolicy {
    fn with_authorized<T>(&self, effect: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        if !self.granted.load(Ordering::Acquire) {
            return Err(AppError::validation("revoked"));
        }
        effect()
    }
    fn commit(&self, effect: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
        self.target.recheck(&self.runtime.rule_states())?;
        effect()
    }
}
async fn setup() -> (
    Arc<MountRegistry>,
    Arc<Coordinator>,
    Arc<AtomicBool>,
    TestPolicy,
) {
    let registry = fixture().await;
    let runtime = Arc::new(Coordinator::default());
    let mut mounts = registry.mounts.lock().await;
    let mount = mounts.get_mut("legacy").unwrap();
    mount.info.owner = OWNER.into();
    mount.generation = 0;
    runtime.adopt_state(
        &Entry {
            revision: "revision".into(),
            value: Rule {
                id: "rule".into(),
                host_id: "host".into(),
                group_id: "group".into(),
                name: "Files".into(),
                remote_path: mount.info.remote_path.clone(),
                mount_point: mount.info.mount_point.clone(),
                read_only: true,
                auto_mount: false,
            },
        },
        &mount.info,
    );
    drop(mounts);
    let granted = Arc::new(AtomicBool::new(true));
    let policy = TestPolicy {
        runtime: runtime.clone(),
        target: Target::capture(&runtime.rule_states(), "rule", "legacy").unwrap(),
        granted: granted.clone(),
        _group: runtime.gate("group").unwrap(),
    };
    (registry, runtime, granted, policy)
}
fn request() -> Request {
    Request {
        id: "legacy".into(),
        owner: OWNER.into(),
        generation: 0,
        session: Some("user-terminal".into()),
        path: Some("/source/file".into()),
        reveal: false,
    }
}
fn plugin_request() -> Request {
    Request {
        id: "legacy".into(),
        owner: "contributor".into(),
        generation: 7,
        session: None,
        path: None,
        reveal: false,
    }
}
fn effects(probe: Option<Gate>, open: Option<Gate>, opened: Arc<AtomicBool>) -> Simulated {
    Simulated {
        probe,
        open,
        opened,
        probes: AtomicUsize::new(0),
        fail: false,
        probe_timeout: false,
    }
}
fn budget() -> Budget {
    Budget::new(4, ERRORS)
}
async fn unchanged(registry: &MountRegistry, runtime: &Coordinator) {
    let mut mounts = registry.mounts.lock().await;
    let mount = mounts.get_mut("legacy").unwrap();
    assert_eq!(mount.info.owner, OWNER);
    assert_eq!(mount.generation, 0);
    assert_eq!(mount.info.session_id, "user-terminal");
    assert!(mount.child.try_wait().unwrap().is_none());
    assert!(!mount.bridge.is_finished());
    assert!(runtime.rule_states()[0].desired);
    assert_eq!(runtime.rule_states()[0].phase, "running");
    assert!(runtime.connection_states().is_empty());
    assert!(runtime.gate("group").is_ok());
}

#[tokio::test]
async fn admitted_open_retains_registry_group_and_effect_after_outer_abort_and_permission_loss() {
    for fail in [false, true] {
        let (registry, runtime, granted, policy) = setup().await;
        let mounts = registry.mounts.clone().lock_owned().await;
        let (gate, ready, release) = Gate::new();
        let (settled, mut done) = oneshot::channel();
        let opened = Arc::new(AtomicBool::new(false));
        let mut effects = effects(None, Some(gate), opened.clone());
        effects.fail = fail;
        let task = tokio::spawn(WorkLifetime::new(Fence(Some(settled))).scope(async move {
            run(
                &budget(),
                mounts,
                request(),
                Admission::capture(policy),
                effects,
            )
            .await
        }));
        ready.await.unwrap();
        assert!(opened.load(Ordering::Acquire));
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        granted.store(false, Ordering::Release);
        assert!(registry.mounts.try_lock().is_err());
        assert!(runtime.gate("group").is_err());
        assert!(done.try_recv().is_err());
        release.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), done)
            .await
            .unwrap()
            .unwrap();
        unchanged(&registry, &runtime).await;
        cleanup(&registry).await;
    }
}

pub(crate) async fn invocation(cancel: impl FnOnce(), before_commit: bool) -> AppResult<()> {
    let (registry, runtime, _, policy) = setup().await;
    let mounts = registry.mounts.clone().lock_owned().await;
    let (gate, ready, release) = Gate::new();
    let opened = Arc::new(AtomicBool::new(false));
    let effects = if before_commit {
        effects(Some(gate), None, opened.clone())
    } else {
        effects(None, Some(gate), opened.clone())
    };
    let admission = Admission::capture(policy);
    let task =
        tokio::spawn(async move { run(&budget(), mounts, request(), admission, effects).await });
    ready.await.unwrap();
    cancel();
    assert!(registry.mounts.try_lock().is_err());
    assert!(runtime.gate("group").is_err());
    release.send(()).unwrap();
    let result = task.await.unwrap();
    if before_commit {
        assert_eq!(result.unwrap_err().to_string(), "plugin.api.cancelled");
    } else {
        result.unwrap();
    }
    assert_eq!(opened.load(Ordering::Acquire), !before_commit);
    unchanged(&registry, &runtime).await;
    cleanup(&registry).await;
    Ok(())
}

#[tokio::test]
async fn permission_or_rule_replacement_during_probe_cannot_open_a_stale_target() {
    for revoke in [false, true] {
        let (registry, runtime, granted, policy) = setup().await;
        let mounts = registry.mounts.clone().lock_owned().await;
        let (gate, ready, release) = Gate::new();
        let opened = Arc::new(AtomicBool::new(false));
        let effects = effects(Some(gate), None, opened.clone());
        let publication = runtime.clone();
        let task = tokio::spawn(async move {
            run(
                &budget(),
                mounts,
                request(),
                Admission::capture(policy),
                effects,
            )
            .await
        });
        ready.await.unwrap();
        if revoke {
            granted.store(false, Ordering::Release);
        } else {
            publication.forget_rule("rule");
        }
        release.send(()).unwrap();
        assert!(task.await.unwrap().is_err());
        assert!(!opened.load(Ordering::Acquire));
        assert!(runtime.gate("group").is_ok());
        cleanup(&registry).await;
    }
}

#[tokio::test]
async fn inner_filesystem_timeout_retains_registry_group_and_native_effect_until_late_probe_returns(
) {
    let (registry, runtime, _, policy) = setup().await;
    let mounts = registry.mounts.clone().lock_owned().await;
    let (gate, ready, release) = Gate::new();
    let (settled, mut done) = oneshot::channel();
    let opened = Arc::new(AtomicBool::new(false));
    let mut effects = effects(Some(gate), None, opened.clone());
    effects.probe_timeout = true;
    let task = tokio::spawn(WorkLifetime::new(Fence(Some(settled))).scope(async move {
        run(
            &budget(),
            mounts,
            request(),
            Admission::capture(policy),
            effects,
        )
        .await
    }));
    ready.await.unwrap();
    assert_eq!(
        task.await.unwrap().unwrap_err().to_string(),
        "mounts.pathTimeout"
    );
    assert!(registry.mounts.try_lock().is_err());
    assert!(runtime.gate("group").is_err());
    assert!(done.try_recv().is_err());
    assert!(!opened.load(Ordering::Acquire));
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), done)
        .await
        .unwrap()
        .unwrap();
    unchanged(&registry, &runtime).await;
    cleanup(&registry).await;
}

#[tokio::test]
async fn wrong_owner_generation_session_or_dead_mount_never_launches() {
    for mismatch in 0..6 {
        let (registry, runtime, _, policy) = setup().await;
        let mut mounts = registry.mounts.clone().lock_owned().await;
        let mount = mounts.get_mut("legacy").unwrap();
        let mut requested = request();
        match mismatch {
            0 => mount.info.owner = "other-plugin".into(),
            1 => mount.generation = 1,
            2 => requested.session = Some("replaced-session".into()),
            3 => mount.info.cleanup_error = Some("mounts.busy".into()),
            4 => {
                mount.child.kill().await.unwrap();
            }
            _ => requested.path = Some("/source/../outside".into()),
        }
        let opened = Arc::new(AtomicBool::new(false));
        assert!(run(
            &budget(),
            mounts,
            requested,
            Admission::capture(policy),
            effects(None, None, opened.clone())
        )
        .await
        .is_err());
        assert!(!opened.load(Ordering::Acquire));
        assert!(runtime.gate("group").is_ok());
        cleanup(&registry).await;
    }
}

#[tokio::test]
async fn legacy_open_binds_the_original_plugin_generation_and_rejects_converted_or_unhealthy_mounts(
) {
    for mismatch in 0..5 {
        let registry = fixture().await;
        let mut mounts = registry.mounts.clone().lock_owned().await;
        let mount = mounts.get_mut("legacy").unwrap();
        match mismatch {
            0 => {}
            1 => mount.info.owner = "other-plugin".into(),
            2 => mount.generation += 1,
            3 => {
                mount.info.owner = OWNER.into();
                mount.generation = 0;
            }
            _ => mount.info.cleanup_error = Some("cleanup required".into()),
        }
        let opened = Arc::new(AtomicBool::new(false));
        let result = run(
            &budget(),
            mounts,
            plugin_request(),
            Admission::capture(|| Ok(())),
            effects(None, None, opened.clone()),
        )
        .await;
        assert_eq!(result.is_ok(), mismatch == 0);
        assert_eq!(opened.load(Ordering::Acquire), mismatch == 0);
        let mut mounts = registry.mounts.lock().await;
        let mount = mounts.get_mut("legacy").unwrap();
        assert!(mount.child.try_wait().unwrap().is_none());
        assert!(!mount.bridge.is_finished());
        assert_eq!(mount.info.session_id, "user-terminal");
        drop(mounts);
        cleanup(&registry).await;
    }
}

#[tokio::test]
async fn legacy_open_outer_abort_keeps_the_registry_reserved_through_the_actual_probe() {
    let registry = fixture().await;
    let mounts = registry.mounts.clone().lock_owned().await;
    let (gate, ready, release) = Gate::new();
    let (settled, mut done) = oneshot::channel();
    let opened = Arc::new(AtomicBool::new(false));
    let effects = effects(Some(gate), None, opened.clone());
    let task = tokio::spawn(WorkLifetime::new(Fence(Some(settled))).scope(async move {
        run(
            &budget(),
            mounts,
            plugin_request(),
            Admission::capture(|| Ok(())),
            effects,
        )
        .await
    }));
    ready.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(registry.mounts.try_lock().is_err());
    assert!(done.try_recv().is_err());
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), done)
        .await
        .unwrap()
        .unwrap();
    assert!(!opened.load(Ordering::Acquire));
    assert_eq!(registry.list(Some("contributor")).await.len(), 1);
    cleanup(&registry).await;
}

pub(crate) async fn plugin_invocation(cancel: impl FnOnce(), before_commit: bool) -> AppResult<()> {
    assert!(crate::plugins::current_invocation_fence().is_some());
    let admission = Admission::capture(|| Ok(()));
    let registry = fixture().await;
    let mounts = registry.mounts.clone().lock_owned().await;
    let (gate, ready, release) = Gate::new();
    let opened = Arc::new(AtomicBool::new(false));
    let effects = if before_commit {
        effects(Some(gate), None, opened.clone())
    } else {
        effects(None, Some(gate), opened.clone())
    };
    let task =
        tokio::spawn(
            async move { run(&budget(), mounts, plugin_request(), admission, effects).await },
        );
    ready.await.unwrap();
    cancel();
    assert!(registry.mounts.try_lock().is_err());
    release.send(()).unwrap();
    let result = task.await.unwrap();
    if before_commit {
        assert_eq!(result.unwrap_err().to_string(), "plugin.api.cancelled");
    } else {
        result.unwrap();
    }
    assert_eq!(opened.load(Ordering::Acquire), !before_commit);
    let mounts = registry.mounts.lock().await;
    assert_eq!(mounts["legacy"].info.owner, "contributor");
    assert_eq!(mounts["legacy"].generation, 7);
    drop(mounts);
    cleanup(&registry).await;
    Ok(())
}

/// Real owned mount registry and retained OS-worker seam, not a FUSE fixture.
pub(crate) async fn pending_plugin_open(
    owner: String,
    generation: u64,
) -> (
    impl std::future::Future<Output = AppResult<()>> + Send,
    oneshot::Receiver<()>,
    std::sync::mpsc::Sender<()>,
    Arc<MountRegistry>,
) {
    let registry = fixture().await;
    let mounts = registry.mounts.clone().lock_owned().await;
    let (gate, ready, release) = Gate::new();
    let mut mounts = mounts;
    let mount = mounts.get_mut("legacy").unwrap();
    mount.info.owner = owner.clone();
    mount.generation = generation;
    let request = Request {
        owner,
        generation,
        ..plugin_request()
    };
    let work = async move {
        run(
            &budget(),
            mounts,
            request,
            Admission::capture(|| Ok(())),
            effects(None, Some(gate), Arc::new(AtomicBool::new(false))),
        )
        .await
    };
    (work, ready, release, registry)
}

pub(crate) fn registry_reserved(registry: &MountRegistry) -> bool {
    registry.mounts.try_lock().is_err()
}
