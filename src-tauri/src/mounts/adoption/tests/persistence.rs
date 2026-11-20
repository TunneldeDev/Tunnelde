//! Real SQLite + child/bridge ownership + coordinator publication. The ordinary
//! subprocess is deliberately NOT a physical FUSE mount or SSH connection.
use super::*;
use crate::services::mounts::{contract::Rule, legacy::tests::setup, repository};

pub(crate) async fn invocation(
    cancel_request: impl FnOnce(),
    before_commit: bool,
) -> AppResult<()> {
    let registry = fixture().await;
    let (db, conversion, _, host) = setup();
    let db = Arc::new(db);
    let runtime = Arc::new(Coordinator::default());
    let group = runtime.gate(&conversion.group).unwrap();
    let fence = crate::plugins::current_invocation_fence().expect("original invocation");
    let (entered, ready) = oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let worker = registry.clone();
    let database = db.clone();
    let publication = runtime.clone();
    let task = tokio::spawn(async move {
        worker
            .adopt_managed(
                "legacy".into(),
                group,
                move |mount, cancel| {
                    // Model the worker being queued / SQLite busy BEFORE admission,
                    // or cancellation immediately AFTER the real DB commit.
                    if before_commit {
                        entered.send(()).unwrap();
                        wait.recv_timeout(std::time::Duration::from_secs(5))
                            .unwrap();
                        fence.with_live(|| {
                            database.with(|conn| conversion.save(conn, mount, &host, cancel))
                        })
                    } else {
                        let saved = fence.with_live(|| {
                            database.with(|conn| conversion.save(conn, mount, &host, cancel))
                        })?;
                        entered.send(()).unwrap();
                        wait.recv_timeout(std::time::Duration::from_secs(5))
                            .unwrap();
                        Ok(saved)
                    }
                },
                move |rule, mount| publication.adopt_state(rule, mount),
            )
            .await
    });
    ready.await.unwrap();
    cancel_request();
    assert!(registry.mounts.try_lock().is_err());
    assert!(runtime.gate("group").is_err());
    release.send(()).unwrap();
    let result = task.await.unwrap();
    if before_commit {
        assert_eq!(result.unwrap_err().to_string(), "plugin.api.cancelled");
        assert!(db
            .with(|conn| repository::all::<Rule>(conn, None))
            .unwrap()
            .is_empty());
        assert!(runtime.rule_states().is_empty());
    } else {
        let saved = result.unwrap();
        let persisted = db
            .with(|conn| repository::get::<Rule>(conn, "rule"))
            .unwrap()
            .unwrap();
        assert_eq!(persisted.revision, saved.revision);
        assert_eq!(persisted.value.remote_path, "/source");
        assert!(persisted.value.read_only && !persisted.value.auto_mount);
        let status = &runtime.rule_states()[0];
        assert_eq!(status.revision, persisted.revision);
        assert_eq!(status.rule_id, persisted.value.id);
        assert_eq!(status.group_id, persisted.value.group_id);
        assert_eq!(status.runtime_id.as_deref(), Some("legacy"));
        assert_eq!(status.session_id.as_deref(), Some("user-terminal"));
        assert_eq!(status.phase, "running");
        assert!(status.desired && status.error.is_none());
    }
    assert!(runtime.gate("group").is_ok());
    // Adoption never adds a Connection: its Drop would disconnect the user's
    // terminal, and recovery must not treat that session as a dedicated one.
    assert!(runtime.connection_states().is_empty());
    runtime.release_connections();
    let mut mounts = registry.mounts.lock().await;
    let mount = mounts.get_mut("legacy").unwrap();
    assert_eq!(
        mount.info.owner,
        if before_commit {
            "contributor"
        } else {
            crate::services::mounts::runtime::OWNER
        }
    );
    assert_eq!(mount.generation, if before_commit { 7 } else { 0 });
    assert_eq!(mount.info.session_id, "user-terminal");
    assert!(!mount.bridge.is_finished());
    assert!(mount.child.try_wait().unwrap().is_none());
    drop(mounts);
    cleanup(&registry).await;
    Ok(())
}

#[tokio::test]
async fn persistence_failure_or_stale_revision_cannot_transfer_or_publish_mount() {
    for sql_failure in [false, true] {
        let registry = fixture().await;
        let (db, mut conversion, _, host) = setup();
        let db = Arc::new(db);
        if sql_failure {
            db.with(|conn| {
                conn.execute_batch("CREATE TRIGGER reject_legacy_rule BEFORE INSERT ON mount_rules BEGIN SELECT RAISE(ABORT, 'test failure'); END;")?;
                Ok(())
            }).unwrap();
        } else {
            conversion.expected = "stale".into();
        }
        let before = db.with(repository::revision).unwrap();
        let runtime = Arc::new(Coordinator::default());
        let group = runtime.gate(&conversion.group).unwrap();
        let database = db.clone();
        let publication = runtime.clone();
        assert!(registry
            .adopt_managed(
                "legacy".into(),
                group,
                move |mount, cancel| database
                    .with(|conn| conversion.save(conn, mount, &host, cancel)),
                move |rule, mount| publication.adopt_state(rule, mount),
            )
            .await
            .is_err());
        assert_eq!(db.with(repository::revision).unwrap(), before);
        assert!(db
            .with(|conn| repository::all::<Rule>(conn, None))
            .unwrap()
            .is_empty());
        assert!(runtime.rule_states().is_empty() && runtime.connection_states().is_empty());
        assert!(runtime.gate("group").is_ok());
        let mut mounts = registry.mounts.lock().await;
        let mount = mounts.get_mut("legacy").unwrap();
        assert_eq!(mount.info.owner, "contributor");
        assert_eq!(mount.generation, 7);
        assert_eq!(mount.info.session_id, "user-terminal");
        assert!(mount.child.try_wait().unwrap().is_none());
        drop(mounts);
        cleanup(&registry).await;
    }
}

#[tokio::test]
async fn closed_registry_or_dead_transport_never_enters_persistence() {
    for kind in [0, 1, 2, 3] {
        let registry = fixture().await;
        {
            let mut mounts = registry.mounts.lock().await;
            let active = mounts.get_mut("legacy").unwrap();
            match kind {
                0 => registry.closed.store(true, Ordering::Release),
                1 => {
                    active.bridge.abort();
                    let _ = (&mut active.bridge).await;
                    active.bridge_joined = true;
                }
                2 => {
                    active.child.kill().await.unwrap();
                }
                _ => active.info.cleanup_error = Some("mounts.busy".into()),
            }
        }
        assert!(registry
            .adopt_managed::<()>(
                "legacy".into(),
                (),
                |_, _| panic!("invalid transport must not persist"),
                |_, _| panic!("invalid transport must not publish"),
            )
            .await
            .is_err());
        let mounts = registry.mounts.lock().await;
        assert_eq!(mounts["legacy"].info.owner, "contributor");
        assert_eq!(mounts["legacy"].generation, 7);
        drop(mounts);
        cleanup(&registry).await;
    }
}
