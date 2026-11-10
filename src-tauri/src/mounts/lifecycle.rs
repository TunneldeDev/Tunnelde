//! Bounded ownership projection; safe unmount remains with the mount registry.
use super::*;
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
        check: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        self.unmount_checked(owner, id, false, Some(generation), check)
            .await
    }
}

/// Never report disposal complete while the owned SSHFS worker is still live.
pub(super) async fn settle_process(active: &mut ActiveMount) -> AppResult<()> {
    if let Err(error) = active.child.kill().await {
        active.info.cleanup_error = Some(error.to_string());
        return Err(error.into());
    }
    active.bridge.abort();
    let _ = (&mut active.bridge).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    struct Settled(Arc<AtomicBool>);
    impl Drop for Settled {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn lifecycle_rechecks_owner_generation_and_policy_before_settling_owned_workers() {
        let registry = MountRegistry::default();
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
        registry.mounts.lock().await.insert(
            "mount".into(),
            ActiveMount {
                info: MountInfo {
                    id: "mount".into(),
                    owner: "owner".into(),
                    session_id: "session".into(),
                    remote_path: "/qa".into(),
                    mount_point: std::env::temp_dir()
                        .join(uuid::Uuid::new_v4().to_string())
                        .to_string_lossy()
                        .into_owned(),
                    read_only: true,
                    cleanup_error: None,
                },
                generation: 1,
                child,
                bridge,
                #[cfg(windows)]
                device_mapping: None,
                #[cfg(target_os = "linux")]
                mount_id: None,
                #[cfg(target_os = "macos")]
                mount_device: None,
            },
        );
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
}
