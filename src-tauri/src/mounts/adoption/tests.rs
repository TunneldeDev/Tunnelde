use super::*;
use crate::services::{mounts::runtime::Coordinator, operations::WorkLifetime};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::oneshot;

pub(crate) async fn fixture() -> Arc<MountRegistry> {
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
    let (ready, started) = oneshot::channel();
    let bridge = tokio::spawn(async {
        ready.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    started.await.unwrap();
    let registry = Arc::new(MountRegistry::default());
    registry.mounts.lock().await.insert(
        "legacy".into(),
        ActiveMount {
            info: MountInfo {
                id: "legacy".into(),
                owner: "contributor".into(),
                session_id: "user-terminal".into(),
                remote_path: "/source".into(),
                mount_point: if cfg!(windows) {
                    "X:\\"
                } else {
                    "/not-a-physical-mount"
                }
                .into(),
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
    registry
}
pub(crate) async fn cleanup(registry: &MountRegistry) {
    let mut mounts = registry.mounts.lock().await;
    if let Some(active) = mounts.get_mut("legacy") {
        lifecycle::settle_process(active).await.unwrap();
    }
    mounts.clear();
}
struct Fence(Option<oneshot::Sender<()>>);
impl Drop for Fence {
    fn drop(&mut self) {
        let _ = self.0.take().unwrap().send(());
    }
}

#[tokio::test]
async fn cancelled_admitted_conversion_publishes_before_releasing_registry_group_and_effect() {
    let registry = fixture().await;
    let runtime = Arc::new(Coordinator::default());
    let group = runtime.gate("group").unwrap();
    let (entered, ready) = oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (fence, mut done) = oneshot::channel();
    let published = Arc::new(AtomicBool::new(false));
    let record = published.clone();
    let worker = registry.clone();
    let task = tokio::spawn(WorkLifetime::new(Fence(Some(fence))).scope(async move {
        worker
            .adopt_managed(
                "legacy".into(),
                group,
                move |_, cancel| {
                    cancel.commit()?;
                    entered.send(()).unwrap();
                    wait.recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    Ok("saved")
                },
                move |saved, mount| {
                    assert_eq!(*saved, "saved");
                    assert_eq!(mount.owner, crate::services::mounts::runtime::OWNER);
                    assert_eq!(mount.session_id, "user-terminal");
                    record.store(true, Ordering::SeqCst);
                },
            )
            .await
    }));
    ready.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(registry.mounts.try_lock().is_err());
    assert!(runtime.gate("group").is_err());
    assert!(done.try_recv().is_err());
    assert!(!published.load(Ordering::SeqCst));
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), done)
        .await
        .unwrap()
        .unwrap();
    assert!(published.load(Ordering::SeqCst));
    assert!(runtime.gate("group").is_ok());
    let mounts = registry.mounts.lock().await;
    assert_eq!(
        mounts["legacy"].info.owner,
        crate::services::mounts::runtime::OWNER
    );
    assert_eq!(mounts["legacy"].generation, 0);
    assert!(!mounts["legacy"].bridge.is_finished());
    drop(mounts);
    cleanup(&registry).await;
}
#[tokio::test]
async fn cancelled_or_failed_conversion_keeps_original_owner_and_runtime() {
    for fail in [false, true] {
        let registry = fixture().await;
        let (entered, ready) = oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let (fence, done) = oneshot::channel();
        let worker = registry.clone();
        let task = tokio::spawn(WorkLifetime::new(Fence(Some(fence))).scope(async move {
            worker
                .adopt_managed(
                    "legacy".into(),
                    (),
                    move |_, cancel| {
                        entered.send(()).unwrap();
                        wait.recv_timeout(std::time::Duration::from_secs(5))
                            .unwrap();
                        cancel.check()?;
                        Err::<(), _>(AppError::validation("sql.failed"))
                    },
                    |_, _| panic!("failed conversion must not publish"),
                )
                .await
        }));
        ready.await.unwrap();
        if fail {
            release.send(()).unwrap();
            assert_eq!(task.await.unwrap().unwrap_err().to_string(), "sql.failed");
        } else {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            release.send(()).unwrap();
        }
        tokio::time::timeout(std::time::Duration::from_secs(3), done)
            .await
            .unwrap()
            .unwrap();
        let mounts = registry.mounts.lock().await;
        assert_eq!(mounts["legacy"].info.owner, "contributor");
        assert_eq!(mounts["legacy"].generation, 7);
        assert_eq!(mounts["legacy"].info.session_id, "user-terminal");
        drop(mounts);
        cleanup(&registry).await;
    }
}

pub(crate) mod persistence;
