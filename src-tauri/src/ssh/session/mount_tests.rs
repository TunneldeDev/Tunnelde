//! Real FUSE coverage of MountRegistry -> authenticated SSH -> OpenSSH SFTP.
use super::*;
use crate::mounts::{MountRegistry, MountRequest};
use std::path::{Path, PathBuf};

mod fixture;

async fn pending_mount_keeps_registry_responsive(root: PathBuf, waiting_for_filesystem: bool) {
    let ssh = Arc::new(SshManager::default());
    let mounts = Arc::new(MountRegistry::default());
    let fixture = if waiting_for_filesystem {
        fixture::Fixture::pending_filesystem().await
    } else {
        fixture::Fixture::stalled().await
    };
    fixture.connect(&ssh, "pending").await;
    let task_ssh = ssh.clone();
    let task_mounts = mounts.clone();
    let mount_request = request(&root, "mount", "pending");
    let task = tokio::spawn(async move {
        task_mounts
            .mount(&task_ssh, "pending-owner", 1, mount_request)
            .await
    });
    let assertions = async {
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.subsystem_count() == 0 {
                assert!(
                    !task.is_finished(),
                    "mount exited before reaching subsystem negotiation"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fixture never received SFTP request");
        if waiting_for_filesystem {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let entries =
                        tokio::time::timeout(Duration::from_millis(500), mounts.list(None))
                            .await
                            .expect("pending mount blocked list");
                    if !entries.is_empty() {
                        break;
                    }
                    assert!(!task.is_finished(), "mount exited before readiness wait");
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("mount was never registered");
        }
        tokio::time::timeout(Duration::from_millis(500), mounts.list(None))
            .await
            .expect("negotiation blocked mount list");
        tokio::time::timeout(
            Duration::from_millis(500),
            mounts.stop_generation("unrelated", 99),
        )
        .await
        .expect("negotiation blocked unrelated cleanup");
        if waiting_for_filesystem {
            tokio::time::timeout(
                Duration::from_secs(4),
                mounts.stop_generation("pending-owner", 1),
            )
            .await
            .expect("readiness wait blocked owner revocation");
            tokio::time::timeout(Duration::from_secs(3), async {
                while !task.is_finished() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("retired mount continued waiting");
        }
    };
    // Keep cleanup outside the assertion task so a failed regression cannot
    // leave an owned process or mount behind.
    let result = std::panic::AssertUnwindSafe(assertions);
    use futures_util::FutureExt;
    let result = result.catch_unwind().await;
    task.abort();
    let mount_result = task.await;
    if let Some(disposal) = ssh.begin_disconnect("pending") {
        let _ = disposal.finish().await;
    }
    for mount in mounts.list(None).await {
        mounts.unmount(&mount.owner, &mount.id, true).await.unwrap();
    }
    assert!(mounts.list(None).await.is_empty());
    // The fixture never returns an SFTP VERSION, so FUSE must not publish a
    // mount. Verify before the caller removes its isolated directories.
    let table = std::fs::read_to_string("/proc/self/mountinfo").unwrap();
    let mount_path = root
        .join("mount")
        .to_str()
        .unwrap()
        .replace('\\', "\\134")
        .replace(' ', "\\040");
    assert!(
        !table
            .lines()
            .any(|line| line.split_whitespace().nth(4) == Some(mount_path.as_str())),
        "pending mount still visible; preserve {}",
        root.display()
    );
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
    if waiting_for_filesystem {
        assert!(mount_result.unwrap().is_err());
    }
}

#[tokio::test]
#[ignore = "requires Linux sshfs and a usable FUSE device"]
async fn real_sshfs_pending_negotiation_and_readiness_do_not_block_registry() {
    assert_eq!(std::env::consts::OS, "linux");
    for readiness in [false, true] {
        let root =
            std::env::temp_dir().join(format!("tunnelde-pending-mount-{}", uuid::Uuid::new_v4()));
        for directory in ["source", "mount"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        pending_mount_keeps_registry_responsive(root.clone(), readiness).await;
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn request(root: &Path, directory: &str, session: &str) -> MountRequest {
    MountRequest {
        session_id: session.into(),
        remote_path: root.join("source").to_str().unwrap().into(),
        mount_point: root.join(directory).to_str().unwrap().into(),
        read_only: true,
    }
}

async fn exercise(
    root: PathBuf,
    ssh: Arc<SshManager>,
    mounts: Arc<MountRegistry>,
    fixture: Arc<fixture::Fixture>,
) {
    fixture.connect(&ssh, "first").await;
    let first = mounts
        .mount(&ssh, "owner-a", 7, request(&root, "mount-a", "first"))
        .await
        .unwrap();
    let second = mounts
        .mount(&ssh, "owner-b", 9, request(&root, "mount-b", "first"))
        .await
        .unwrap();
    assert_eq!(fixture.subsystem_count(), 2);
    assert_eq!(mounts.list(Some("owner-a")).await.len(), 1);
    assert_eq!(mounts.list(Some("owner-b")).await.len(), 1);
    assert_eq!(
        tokio::fs::read(root.join("mount-a/file.txt"))
            .await
            .unwrap(),
        b"SSH session mount"
    );
    assert!(
        tokio::fs::write(root.join("mount-a/file.txt"), b"overwrite")
            .await
            .is_err()
    );
    assert_eq!(
        tokio::fs::read(root.join("source/file.txt")).await.unwrap(),
        b"SSH session mount"
    );
    assert_eq!(
        mounts
            .unmount("owner-b", &first.id, false)
            .await
            .unwrap_err()
            .to_string(),
        "mounts.notOwned"
    );
    mounts.stop_generation("owner-a", 6).await;
    assert_eq!(mounts.list(Some("owner-a")).await.len(), 1);
    mounts.stop_generation("owner-a", 7).await;
    let remaining = mounts.list(Some("owner-a")).await;
    assert!(
        remaining.is_empty(),
        "revocation cleanup incomplete: {remaining:?}"
    );
    assert_eq!(
        tokio::fs::read(root.join("mount-b/file.txt"))
            .await
            .unwrap(),
        b"SSH session mount"
    );

    ssh.begin_disconnect("first")
        .unwrap()
        .finish()
        .await
        .unwrap();
    // EOF must reach sshfs itself, without stop_session aborting the bridge first.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            mounts.reap().await;
            if mounts
                .list(Some("owner-b"))
                .await
                .iter()
                .any(|m| m.cleanup_error.is_some())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("disconnected SSH left its mount transport waiting for EOF");
    mounts.stop_session("first").await;
    assert!(mounts.list(None).await.is_empty());
    assert!(!root.join("mount-b/file.txt").exists());

    fixture.connect(&ssh, "reconnected").await;
    let replacement = mounts
        .mount(
            &ssh,
            "owner-b",
            10,
            request(&root, "mount-b", "reconnected"),
        )
        .await
        .unwrap();
    assert_ne!(replacement.id, second.id);
    assert_eq!(fixture.subsystem_count(), 3);
    assert_eq!(
        tokio::fs::read(root.join("mount-b/file.txt"))
            .await
            .unwrap(),
        b"SSH session mount"
    );
    mounts
        .unmount("owner-b", &replacement.id, false)
        .await
        .unwrap();
    assert!(mounts.list(None).await.is_empty());
}

#[tokio::test]
#[ignore = "requires Linux, sshfs, OpenSSH sftp-server and a usable FUSE device"]
async fn real_sshfs_session_bridge_is_owned_readonly_and_disconnects() {
    // Revocation races the SSHFS worker's EOF/exit path. Exercise fresh mounts
    // repeatedly: a single successful scheduling must not hide a leaked record.
    for _ in 0..5 {
        exercise_owned_session_fixture().await;
    }
}

async fn exercise_owned_session_fixture() {
    assert_eq!(
        std::env::consts::OS,
        "linux",
        "Linux integration fixture only"
    );
    let root =
        std::env::temp_dir().join(format!("tunnelde-session-mount-{}", uuid::Uuid::new_v4()));
    for directory in ["source", "mount-a", "mount-b"] {
        std::fs::create_dir_all(root.join(directory)).unwrap();
    }
    std::fs::write(root.join("source/file.txt"), b"SSH session mount").unwrap();
    let ssh = Arc::new(SshManager::default());
    let mounts = Arc::new(MountRegistry::default());
    let fixture = Arc::new(fixture::Fixture::start().await);
    let mut run = tokio::spawn(exercise(
        root.clone(),
        ssh.clone(),
        mounts.clone(),
        fixture.clone(),
    ));
    let result = tokio::time::timeout(Duration::from_secs(60), &mut run).await;
    if result.is_err() {
        run.abort();
        let _ = run.await;
    }
    // Cleanup runs even after a failed assertion in the spawned test body.
    for id in ["first", "reconnected"] {
        if let Some(disposal) = ssh.begin_disconnect(id) {
            let _ = disposal.finish().await;
        }
    }
    for mount in mounts.list(None).await {
        let _ = mounts.unmount(&mount.owner, &mount.id, true).await;
    }
    assert!(
        mounts.list(None).await.is_empty(),
        "cleanup incomplete; preserving {}",
        root.display()
    );
    // Never recurse through a remaining FUSE mount after an uncertain cleanup.
    let table = std::fs::read_to_string("/proc/self/mountinfo").unwrap();
    for directory in ["mount-a", "mount-b"] {
        let path = root
            .join(directory)
            .to_str()
            .unwrap()
            .replace('\\', "\\134")
            .replace(' ', "\\040")
            .replace('\t', "\\011")
            .replace('\n', "\\012");
        assert!(
            !table
                .lines()
                .any(|line| line.split_whitespace().nth(4) == Some(path.as_str())),
            "mount still visible; preserving {}",
            root.display()
        );
    }
    std::fs::remove_dir_all(&root).unwrap();
    result
        .expect("SSHFS integration deadline")
        .expect("SSHFS integration assertions");
}
