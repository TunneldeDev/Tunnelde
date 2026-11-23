//! Bounded ownership projection; safe unmount remains with the mount registry.
use super::*;

/// Dropping mount startup must close access even when its caller disappears
/// during readiness probing. Keep the registered record for safe OS cleanup.
pub(super) struct PendingMount(Option<tokio::task::AbortHandle>);

impl PendingMount {
    pub(super) fn new(bridge: &tokio::task::JoinHandle<()>) -> Self {
        Self(Some(bridge.abort_handle()))
    }

    pub(super) fn complete(mut self) {
        self.0.take();
    }
}

impl Drop for PendingMount {
    fn drop(&mut self) {
        if let Some(bridge) = self.0.take() {
            bridge.abort();
        }
    }
}

impl MountRegistry {
    pub(crate) async fn owned_resources(
        &self,
        owner: &str,
        generation: u64,
    ) -> AppResult<Vec<(String, bool)>> {
        Ok(self
            .mounts
            .lock()
            .await
            .values()
            .filter(|m| m.info.owner == owner && m.generation == generation)
            .take(4097)
            .map(|m| {
                (
                    m.info.id.clone(),
                    m.info.cleanup_error.is_some() || m.bridge.is_finished(),
                )
            })
            .collect())
    }
    pub(crate) async fn release_owned_resource(
        &self,
        owner: &str,
        generation: u64,
        id: &str,
        check: impl unmount::Policy,
    ) -> AppResult<()> {
        self.unmount_checked(owner, id, false, Some(generation), check)
            .await
    }
}

/// Cleanup needs absence of *any* filesystem at this exact path. A stacked or
/// foreign mount is not absence merely because it fails SSHFS identity checks.
#[cfg(any(target_os = "linux", test))]
fn any_mount_in_table(table: &str, mount_point: &str) -> bool {
    mount_entries(table).any(|(_, path, _)| path == mount_point)
}

pub(super) async fn filesystem_present(mount_point: &str) -> AppResult<bool> {
    #[cfg(target_os = "linux")]
    {
        let table = filesystem::mount_table().await?;
        Ok(any_mount_in_table(&table, mount_point))
    }
    #[cfg(target_os = "macos")]
    {
        let output = helper::output(
            command("/sbin/mount"),
            std::time::Duration::from_secs(2),
            4 * 1024 * 1024,
            "mounts.unmountTimeout",
        )
        .await?;
        if !output.status.success() {
            return Err(AppError::internal("mounts.unmountProbeFailed"));
        }
        let table = std::str::from_utf8(&output.stdout)
            .map_err(|_| AppError::internal("mounts.unmountProbeFailed"))?;
        let marker = format!(" on {mount_point} (");
        Ok(table.lines().any(|line| line.contains(&marker)))
    }
    #[cfg(windows)]
    {
        mount_visible(mount_point).await
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    Err(AppError::validation("mounts.dependencies.required"))
}

/// A failed helper exit can mean SSHFS already removed the filesystem while
/// handling EOF. Only a fresh, successful absence probe may reconcile that
/// failure; stderr text and a dead worker are not proof of an unmounted volume.
#[cfg(any(not(windows), test))]
async fn reconcile_unmount(
    result: AppResult<()>,
    visible: impl std::future::Future<Output = AppResult<bool>>,
) -> AppResult<()> {
    match result {
        Ok(()) => Ok(()),
        Err(error) => match visible.await {
            Ok(false) => Ok(()),
            Ok(true) | Err(_) => Err(error),
        },
    }
}

#[cfg(not(windows))]
pub(super) async fn unmount_filesystem(mount_point: &str, force: bool) -> AppResult<()> {
    let attempt = async {
        let mut cmd = if cfg!(target_os = "macos") {
            let mut cmd = command("diskutil");
            cmd.arg("unmount");
            if force {
                cmd.arg("force");
            }
            cmd
        } else {
            let mut cmd = command("fusermount3");
            cmd.arg(if force { "-uz" } else { "-u" });
            cmd
        };
        cmd.arg(mount_point);
        let mut output = dismount_output(cmd).await;
        if cfg!(target_os = "linux")
            && matches!(&output, Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound)
        {
            let mut fallback = command("fusermount");
            fallback
                .arg(if force { "-uz" } else { "-u" })
                .arg(mount_point);
            output = dismount_output(fallback).await;
        }
        let output = output?;
        if !output.status.success() {
            tracing::warn!(stderr = %String::from_utf8_lossy(&output.stderr).chars().take(2048).collect::<String>(), "SSHFS unmount helper failed");
            return Err(AppError::validation("mounts.busy"));
        }
        Ok(())
    };
    reconcile_unmount(attempt.await, filesystem_present(mount_point)).await
}

/// Must be awaited inside the retained unmount transaction. Never move only
/// this child to a detached task while releasing the registry's owned guard.
#[cfg(not(windows))]
async fn dismount_output(mut command: Command) -> AppResult<std::process::Output> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    helper::collect(
        &mut child,
        std::time::Duration::from_secs(5),
        32768,
        "mounts.unmountTimeout",
    )
    .await
}

/// Failed normal unmount must still revoke authenticated access. Never kill a
/// record adopted by another owner while the earlier attempt was pending. The
/// caller retries normal unmount only after the exact owned workers settle.
pub(super) async fn revoke_failed_unmount(
    registry: &MountRegistry,
    mount: &MountInfo,
    error: &AppError,
) -> bool {
    let mut mounts = registry.mounts.lock().await;
    let Some(active) = mounts
        .get_mut(&mount.id)
        .filter(|active| active.info.owner == mount.owner)
    else {
        return false;
    };
    crate::diagnostics::failure::native("mounts", "unmountBeforeRetry", error);
    active.info.cleanup_error = Some(error.to_string());
    active.bridge.abort();
    settle_process(active).await.is_ok()
}

/// Never report disposal complete while the owned SSHFS worker is still live.
pub(super) async fn settle_process(active: &mut ActiveMount) -> AppResult<()> {
    if let Err(error) = active.child.kill().await {
        active.info.cleanup_error = Some(error.to_string());
        let error = error.into();
        crate::diagnostics::failure::native("mounts", "killWorker", &error);
        return Err(error);
    }
    active.bridge.abort();
    // A failed OS cleanup may keep this record for a later retry. Joining an
    // already-consumed JoinHandle panics; cancellation before Ready is safe to
    // retry, and there is no await between consuming Ready and marking it.
    if !active.bridge_joined {
        let _ = (&mut active.bridge).await;
        active.bridge_joined = true;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    #[tokio::test]
    async fn cancelled_readiness_aborts_bridge_but_completed_start_keeps_it_running() {
        let first = tokio::spawn(std::future::pending::<()>());
        drop(PendingMount::new(&first));
        assert!(first.await.unwrap_err().is_cancelled());
        let second = tokio::spawn(std::future::pending::<()>());
        PendingMount::new(&second).complete();
        assert!(!second.is_finished());
        second.abort();
        assert!(second.await.unwrap_err().is_cancelled());
    }

    struct Settled(Arc<AtomicBool>);
    impl Drop for Settled {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    fn active_mount(owner: &str, generation: u64) -> (ActiveMount, Arc<AtomicBool>) {
        let mut cmd = if cfg!(windows) {
            let mut c = command("powershell.exe");
            c.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ]);
            c
        } else {
            let mut c = command("sh");
            c.args(["-c", "exec sleep 60"]);
            c
        };
        let child = cmd.kill_on_drop(true).spawn().unwrap();
        let settled = Arc::new(AtomicBool::new(false));
        let guard = Settled(settled.clone());
        let bridge = tokio::spawn(async move {
            let _guard = guard;
            std::future::pending::<()>().await;
        });
        let active = ActiveMount {
            info: MountInfo {
                id: "mount".into(),
                owner: owner.into(),
                session_id: "session".into(),
                remote_path: "/qa".into(),
                mount_point: std::env::temp_dir()
                    .join(uuid::Uuid::new_v4().to_string())
                    .to_string_lossy()
                    .into_owned(),
                read_only: true,
                cleanup_error: None,
            },
            generation,
            child,
            bridge,
            bridge_joined: false,
            #[cfg(windows)]
            device_mapping: None,
            #[cfg(target_os = "linux")]
            mount_id: None,
            #[cfg(target_os = "macos")]
            mount_device: None,
        };
        (active, settled)
    }

    #[tokio::test]
    async fn lifecycle_rechecks_owner_generation_and_policy_before_settling_owned_workers() {
        let registry = MountRegistry::default();
        let (active, settled) = active_mount("owner", 1);
        registry.mounts.lock().await.insert("mount".into(), active);
        assert!(registry
            .owned_resources("other", 1)
            .await
            .unwrap()
            .is_empty());
        assert!(registry
            .owned_resources("owner", 2)
            .await
            .unwrap()
            .is_empty());
        assert!(registry
            .release_owned_resource("other", 1, "mount", || panic!(
                "foreign policy callback ran"
            ))
            .await
            .is_err());
        assert!(registry
            .release_owned_resource("owner", 2, "mount", || panic!("stale policy callback ran"))
            .await
            .is_err());
        assert!(registry
            .release_owned_resource("owner", 1, "mount", || Err(AppError::validation(
                "policy-retired"
            )))
            .await
            .is_err());
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
        assert!(!settled.load(Ordering::SeqCst));
        assert_eq!(
            registry.owned_resources("owner", 1).await.unwrap(),
            vec![("mount".into(), false)]
        );
        // No physical FUSE mount is created by this test. Verify worker
        // settlement directly instead of dismounting an arbitrary drive letter.
        let mut mounts = registry.mounts.lock().await;
        settle_process(mounts.get_mut("mount").unwrap())
            .await
            .unwrap();
        mounts.remove("mount");
        drop(mounts);
        assert!(settled.load(Ordering::SeqCst));
        assert!(registry
            .owned_resources("owner", 1)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn cleanup_presence_never_confuses_foreign_or_stacked_mounts_with_absence() {
        let table = "1 0 0:1 / /media/ssh\\040files rw - fuse.sshfs Tunnelde rw\n2 0 0:2 / /media/local rw - ext4 /dev/sda rw";
        assert!(any_mount_in_table(table, "/media/ssh files"));
        assert!(any_mount_in_table(table, "/media/local"));
        assert!(!any_mount_in_table(table, "/media/ssh"));
        let stacked = format!("{table}\n3 0 0:3 / /media/ssh\\040files rw - ext4 /dev/sda rw");
        assert!(mount_id_in_table(&stacked, "/media/ssh files").is_none());
        assert!(any_mount_in_table(&stacked, "/media/ssh files"));
    }

    #[tokio::test]
    async fn failed_helper_is_reconciled_only_by_confirmed_filesystem_absence() {
        let busy = || Err(AppError::validation("mounts.busy"));
        reconcile_unmount(busy(), async { Ok(false) })
            .await
            .unwrap();
        assert_eq!(
            reconcile_unmount(busy(), async { Ok(true) })
                .await
                .unwrap_err()
                .to_string(),
            "mounts.busy"
        );
        assert_eq!(
            reconcile_unmount(busy(), async { Err(AppError::internal("probe failed")) })
                .await
                .unwrap_err()
                .to_string(),
            "mounts.busy"
        );
        reconcile_unmount(Ok(()), async { panic!("successful helper needs no probe") })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn failed_unmount_revokes_and_settles_only_the_exact_owner_then_keeps_cleanup_record() {
        let registry = MountRegistry::default();
        let (active, settled) = active_mount("adopted", 0);
        let mut previous = active.info.clone();
        previous.owner = "previous".into();
        registry.mounts.lock().await.insert("mount".into(), active);
        let busy = AppError::validation("mounts.busy");
        assert!(!revoke_failed_unmount(&registry, &previous, &busy).await);
        assert!(!settled.load(Ordering::SeqCst));
        {
            let mut mounts = registry.mounts.lock().await;
            let active = mounts.get_mut("mount").unwrap();
            assert!(active.child.try_wait().unwrap().is_none());
            assert!(active.info.cleanup_error.is_none());
        }
        previous.owner = "adopted".into();
        assert!(revoke_failed_unmount(&registry, &previous, &busy).await);
        assert!(settled.load(Ordering::SeqCst));
        assert!(revoke_failed_unmount(&registry, &previous, &busy).await);
        {
            let mut mounts = registry.mounts.lock().await;
            let active = mounts.get_mut("mount").unwrap();
            assert!(active.child.try_wait().unwrap().is_some());
            assert!(active.bridge.is_finished());
            assert_eq!(active.info.cleanup_error.as_deref(), Some("mounts.busy"));
        }
        // No physical filesystem was mounted. A fresh absence check may now
        // remove the old record, not merely the fact that its workers exited.
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            registry.unmount("adopted", "mount", false).await.unwrap();
            assert!(registry.list(None).await.is_empty());
        }
        registry.mounts.lock().await.clear();
        assert!(!revoke_failed_unmount(&registry, &previous, &busy).await);
    }

    #[tokio::test]
    async fn host_maintenance_skips_reservations_and_retires_broken_bridges_without_read_side_effects(
    ) {
        let registry = MountRegistry::default();
        let (healthy, healthy_settled) = active_mount("healthy-owner", 1);
        let (mut broken, _) = active_mount("broken-owner", 2);
        broken.info.id = "broken".into();
        broken.bridge.abort();
        let _ = (&mut broken.bridge).await;
        broken.bridge_joined = true;
        {
            let mut mounts = registry.mounts.lock().await;
            mounts.insert("healthy".into(), healthy);
            mounts.insert("broken".into(), broken);
            assert!(
                !registry.reap_if_idle(),
                "maintenance waited on a reserved registry"
            );
        }
        // A snapshot is not permission to perform lifecycle cleanup, even for
        // an already broken bridge. No FUSE filesystem exists in this fixture.
        let snapshot = registry.list(Some("broken-owner")).await;
        assert_eq!(snapshot.len(), 1);
        assert!(snapshot[0].cleanup_error.is_none());
        assert!(registry
            .mounts
            .lock()
            .await
            .get_mut("broken")
            .unwrap()
            .child
            .try_wait()
            .unwrap()
            .is_none());
        // The production host loop calls this without any plugin request.
        assert!(registry.reap_if_idle());
        assert!(
            !registry.reap_if_idle(),
            "unchanged cleanup status was republished"
        );
        let mut mounts = registry.mounts.lock().await;
        let healthy = mounts.get_mut("healthy").unwrap();
        assert!(healthy.child.try_wait().unwrap().is_none());
        assert!(healthy.info.cleanup_error.is_none());
        assert!(!healthy_settled.load(Ordering::SeqCst));
        settle_process(healthy).await.unwrap();
        let broken = mounts.get_mut("broken").unwrap();
        assert_eq!(
            broken.info.cleanup_error.as_deref(),
            Some("mounts.transportClosed")
        );
        assert_eq!(broken.info.owner, "broken-owner");
        assert_eq!(broken.generation, 2);
        settle_process(broken).await.unwrap();
        assert_eq!(
            mounts.len(),
            2,
            "worker exit is not proof of filesystem absence"
        );
        mounts.clear();
    }

    #[tokio::test]
    async fn host_maintenance_marks_exited_processes_without_overwriting_cleanup_errors() {
        let registry = MountRegistry::default();
        for (id, prior) in [("fresh", None), ("failed", Some("original-cleanup-error"))] {
            let (mut active, _) = active_mount(id, 1);
            active.info.id = id.into();
            active.info.cleanup_error = prior.map(str::to_owned);
            active.child.kill().await.unwrap();
            registry.mounts.lock().await.insert(id.into(), active);
        }
        assert!(registry.reap_if_idle());
        assert!(!registry.reap_if_idle());
        let mut mounts = registry.mounts.lock().await;
        assert_eq!(
            mounts["fresh"].info.cleanup_error.as_deref(),
            Some("mounts.processExited")
        );
        assert_eq!(
            mounts["failed"].info.cleanup_error.as_deref(),
            Some("original-cleanup-error")
        );
        for active in mounts.values_mut() {
            settle_process(active).await.unwrap();
        }
        mounts.clear();
    }
}
