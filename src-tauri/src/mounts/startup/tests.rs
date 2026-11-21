use super::*;
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
struct Check {
    live: Arc<AtomicBool>,
    cancel: Cancellation,
}
impl Gate for Check {
    fn check(&self) -> AppResult<()> {
        if !self.live.load(Ordering::SeqCst) {
            return Err(AppError::validation("expired"));
        }
        self.cancel.check()
    }
    fn commit(&self) -> AppResult<()> {
        self.check()?;
        self.cancel.commit()
    }
}
#[tokio::test]
async fn denied_origin_precedes_filesystem_or_connection_access() {
    let (cancel, _pending) = Cancellation::for_test("cancelled");
    let gate = Check {
        live: Arc::new(AtomicBool::new(false)),
        cancel,
    };
    let registry = MountRegistry::default();
    let error = registry
        .mount_gated(
            &SshManager::default(),
            "owner",
            7,
            MountRequest {
                session_id: "missing".into(),
                remote_path: "/".into(),
                mount_point: "/never-probe".into(),
                read_only: true,
            },
            &gate,
        )
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "expired");
    assert!(registry.list(None).await.is_empty());
}
#[tokio::test]
async fn cancellation_revocation_connection_replacement_and_readiness_failure_cleanup_before_return(
) {
    for reason in ["cancelled", "expired", "connection", "readiness"] {
        let (cancel, pending) = Cancellation::for_test("cancelled");
        let live = Arc::new(AtomicBool::new(reason != "expired"));
        let gate = Check { live, cancel };
        let pending = if reason == "cancelled" {
            drop(pending);
            None
        } else {
            Some(pending)
        };
        let (entered, ready) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _pending = pending;
            finish(
                if reason == "readiness" {
                    Err(AppError::validation(reason))
                } else {
                    Ok(())
                },
                || {
                    if reason == "connection" {
                        Err(AppError::validation(reason))
                    } else {
                        Ok(())
                    }
                },
                &gate,
                async move {
                    entered.send(()).unwrap();
                    wait.await.unwrap();
                },
            )
            .await
        });
        ready.await.unwrap();
        assert!(
            !task.is_finished(),
            "cleanup must be awaited, not just scheduled"
        );
        release.send(()).unwrap();
        assert_eq!(task.await.unwrap().unwrap_err().to_string(), reason);
    }
}
#[tokio::test]
async fn successful_startup_commits_without_running_cleanup() {
    let (cancel, _pending) = Cancellation::for_test("cancelled");
    let gate = Check {
        live: Arc::new(AtomicBool::new(true)),
        cancel,
    };
    finish(Ok(()), || Ok(()), &gate, async {
        panic!("accepted mount was disposed");
    })
    .await
    .unwrap();
    assert!(gate.commit().is_err(), "publication may commit only once");
}

async fn fixture() -> (MountRegistry, MountInfo, Arc<AtomicBool>) {
    // Ordinary child + never-mounted empty directory: process settlement test,
    // NOT evidence that SSHFS/FUSE mounted successfully on this platform.
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
    let path = std::env::temp_dir().join(format!("tunnelde-start-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    let info = MountInfo {
        id: uuid::Uuid::new_v4().to_string(),
        owner: "owner".into(),
        session_id: "parent-must-survive".into(),
        remote_path: "/qa".into(),
        mount_point: path.to_string_lossy().into(),
        read_only: true,
        cleanup_error: None,
    };
    struct Exit(Arc<AtomicBool>);
    impl Drop for Exit {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let settled = Arc::new(AtomicBool::new(false));
    let exit = Exit(settled.clone());
    let (send, wait) = oneshot::channel();
    let bridge = tokio::spawn(async move {
        let _exit = exit;
        let _ = send.send(());
        std::future::pending::<()>().await;
    });
    wait.await.unwrap();
    let registry = MountRegistry::default();
    registry.mounts.lock().await.insert(
        info.id.clone(),
        ActiveMount {
            info: info.clone(),
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
    (registry, info, settled)
}
#[tokio::test]
async fn lost_startup_output_retains_fence_until_real_child_reaped_and_record_removed() {
    let (registry, info, settled) = fixture().await;
    let path = info.mount_point.clone();
    let mounts = registry.mounts.clone();
    let capacity = Arc::new(Semaphore::new(1));
    let budget = Budget::with_capacity(capacity.clone(), ERRORS);
    let (started, ready) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    let (fence, done) = oneshot::channel();
    let task = tokio::spawn(WorkLifetime::new(Fence(Some(fence))).scope(async move {
        deliver(&budget, mounts, move |cancel| async move {
            cancel.commit()?;
            started.send(()).unwrap();
            wait.await.unwrap();
            Ok(info)
        })
        .await
    }));
    ready.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    assert!(!settled.load(Ordering::SeqCst));
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), done)
        .await
        .unwrap()
        .unwrap();
    assert!(settled.load(Ordering::SeqCst));
    assert!(registry.list(None).await.is_empty());
    assert_eq!(capacity.available_permits(), 1);
    std::fs::remove_dir(path).unwrap();
}
#[tokio::test]
async fn accepted_output_stays_registered_until_explicit_cleanup() {
    let (registry, info, settled) = fixture().await;
    let path = info.mount_point.clone();
    let id = info.id.clone();
    let budget = Budget::new(1, ERRORS);
    let accepted = deliver(&budget, registry.mounts.clone(), move |cancel| async move {
        cancel.commit()?;
        Ok(info)
    })
    .await
    .unwrap();
    assert_eq!(accepted.id, id);
    assert_eq!(registry.list(None).await.len(), 1);
    assert!(!settled.load(Ordering::SeqCst));
    registry.retire_startup(accepted).await;
    assert!(registry.list(None).await.is_empty());
    assert!(settled.load(Ordering::SeqCst));
    std::fs::remove_dir(path).unwrap();
}
