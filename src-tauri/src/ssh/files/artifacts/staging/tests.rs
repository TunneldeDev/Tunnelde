use super::super::test_support::{client, directory_client, Gate, Tree};
use super::*;
use std::sync::Mutex;
use std::time::Duration;

fn acknowledgement_db(to: &Endpoint) -> (rusqlite::Connection, ArtifactRecord, Endpoint) {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)").unwrap();
    let mut saved = record(to);
    if let ArtifactRecord::Current {
        staging: Some(staging),
        ..
    } = &mut saved
    {
        staging.prepared = false;
        staging.opening = false;
        staging.creating = true;
    }
    let directory = staging_directory(to, "job", remote_staging(Some(&saved)).unwrap()).unwrap();
    conn.execute(
        "INSERT INTO settings VALUES(?1,?2,0)",
        rusqlite::params![
            artifact_key("job", to),
            serde_json::to_string(&saved).unwrap()
        ],
    )
    .unwrap();
    (conn, saved, directory)
}

#[tokio::test]
async fn paused_creation_keeps_polling_and_settles_before_cleanup() {
    for before_create in [true, false] {
        let to = Endpoint {
            session: Some("remote".into()),
            path: "/target".into(),
        };
        let (conn, _, directory) = acknowledgement_db(&to);
        let conn = Arc::new(Mutex::new(conn));
        let tree = Arc::new(Mutex::new(Tree::default()));
        let gate = Arc::new(Gate {
            before_create,
            arrived: tokio::sync::Semaphore::new(0),
            release: tokio::sync::Semaphore::new(0),
            finished: tokio::sync::Semaphore::new(0),
        });
        let data = directory_client(tree.clone(), Some(gate.clone())).await;
        let observer = client(tree.clone(), None).await;
        let cancel = AtomicBool::new(false);
        let done = Arc::new(tokio::sync::Semaphore::new(0));
        let operation = {
            let conn = conn.clone();
            let to = to.clone();
            let directory = directory.clone();
            let done = done.clone();
            async move {
                let result = data.create_private_directory(&directory.path).await?;
                assert!(settle_creation(
                    &conn.lock().unwrap(),
                    "job",
                    &to,
                    &directory,
                    true
                )?);
                done.add_permits(1);
                result.into_result()
            }
        };
        let result = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(await_creation(&cancel, || Ok(operation)), async {
                gate.arrived.acquire().await.unwrap().forget();
                cancel.store(true, Ordering::SeqCst);
            })
            .0
        })
        .await
        .unwrap();
        assert!(matches!(result,Err(AppError::Ssh(ref error)) if error == CANCELLED));
        assert!(matches!(
            cleanup_directory(&observer, &directory, true).await,
            Err(AppError::TransferCreationUnconfirmed { .. })
        ));
        assert_eq!(
            tree.lock().unwrap().directories.contains(&directory.path),
            !before_create
        );
        gate.release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), done.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        let raw: String = conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM settings WHERE key=?1",
                [artifact_key("job", &to)],
                |row| row.get(0),
            )
            .unwrap();
        let settled: ArtifactRecord = serde_json::from_str(&raw).unwrap();
        require_creation_settled("job", &to, Some(&settled)).unwrap();
        cleanup_directory(&observer, &directory, false)
            .await
            .unwrap();
        assert!(!tree.lock().unwrap().directories.contains(&directory.path));
        observer.close().await.unwrap();
    }
}

#[tokio::test]
async fn precancelled_creation_never_polls_or_spawns_the_mutation() {
    let polled = Arc::new(AtomicBool::new(false));
    let observed = polled.clone();
    assert!(await_creation(&AtomicBool::new(true), || {
        observed.store(true, Ordering::SeqCst);
        Ok(async { Ok(()) })
    })
    .await
    .is_err());
    tokio::task::yield_now().await;
    assert!(!polled.load(Ordering::SeqCst));
}

#[tokio::test]
async fn transport_failure_never_settles_the_creation_journal() {
    let to = Endpoint {
        session: Some("remote".into()),
        path: "/target".into(),
    };
    let (conn, saved, _) = acknowledgement_db(&to);
    let cancel = AtomicBool::new(false);
    assert!(await_creation(&cancel, || Ok(async {
        Err(AppError::Ssh("connection lost".into()))
    }))
    .await
    .is_err());
    let raw: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [artifact_key("job", &to)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(raw, serde_json::to_string(&saved).unwrap());
    assert!(matches!(
        require_creation_settled("job", &to, Some(&saved)),
        Err(AppError::TransferCreationUnconfirmed { .. })
    ));
}

#[test]
fn late_acknowledgement_cannot_replace_a_new_generation_or_recreate_deleted_journals() {
    let to = Endpoint {
        session: Some("remote".into()),
        path: "/target".into(),
    };
    let (conn, saved, directory) = acknowledgement_db(&to);
    let (_, replacement, _) = acknowledgement_db(&to);
    let raw = serde_json::to_string(&replacement).unwrap();
    conn.execute("UPDATE settings SET value=?1", [&raw])
        .unwrap();
    assert!(!settle_creation(&conn, "job", &to, &directory, true).unwrap());
    let actual: String = conn
        .query_row("SELECT value FROM settings", [], |row| row.get(0))
        .unwrap();
    assert_eq!(actual, raw);
    conn.execute("DELETE FROM settings", []).unwrap();
    assert!(!settle_creation(&conn, "job", &to, &directory, true).unwrap());
    assert!(require_creation_settled("job", &to, Some(&saved)).is_err());
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn acknowledged_rejection_never_reuses_a_possibly_foreign_directory() {
    let to = Endpoint {
        session: Some("remote".into()),
        path: "/target".into(),
    };
    let (conn, _, old) = acknowledgement_db(&to);
    assert!(settle_creation(&conn, "job", &to, &old, false).unwrap());
    let raw: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [artifact_key("job", &to)],
            |row| row.get(0),
        )
        .unwrap();
    let next: ArtifactRecord = serde_json::from_str(&raw).unwrap();
    let stage = remote_staging(Some(&next)).unwrap();
    assert!(!stage.prepared && !stage.creating && !stage.opening);
    assert_ne!(staging_directory(&to, "job", stage).unwrap().path, old.path);
    assert!(!settle_creation(&conn, "job", &to, &old, true).unwrap());
}

#[tokio::test]
async fn private_directory_creation_sets_permissions_without_a_chmod_window() {
    let tree = Arc::new(Mutex::new(Tree::default()));
    let observer = client(tree.clone(), None).await;
    let data = directory_client(tree.clone(), None).await;
    let data_ref = &data;
    let directory = Endpoint {
        session: Some("remote".into()),
        path: "/private-stage".into(),
    };
    ensure_private_directory(
        &observer,
        &directory,
        &AtomicBool::new(false),
        |path| async move {
            data_ref
                .create_private_directory(&path.path)
                .await?
                .into_result()
        },
    )
    .await
    .unwrap();
    // This protocol server does not implement SETSTAT: creation must supply the
    // final permissions itself and succeed without any permission-widening step.
    assert_eq!(tree.lock().unwrap().modes[&directory.path], 0o40700);
    observer.close().await.unwrap();
}

#[tokio::test]
async fn exclusive_staging_create_never_overwrites_an_existing_object() {
    let tree = Arc::new(Mutex::new(Tree::default()));
    tree.lock()
        .unwrap()
        .directories
        .insert("/private-stage".into());
    let path = "/private-stage/foreign.part";
    tree.lock()
        .unwrap()
        .files
        .insert(path.into(), b"preserve".to_vec());
    let observer = client(tree.clone(), None).await;
    let part = Endpoint {
        session: Some("remote".into()),
        path: path.into(),
    };
    // No LSTAT is necessary to make exclusive OPEN safe: an existing entry must
    // make OPEN fail, without permitting truncation or a subsequent data writer.
    assert!(
        create_writer(&part, Some(&observer), false, &Default::default())
            .await
            .is_err()
    );
    assert_eq!(tree.lock().unwrap().files[path], b"preserve");
    observer.close().await.unwrap();
}

#[tokio::test]
async fn length_probe_classifies_the_same_metadata_without_duplicate_round_trips() {
    let tree = Arc::new(Mutex::new(Tree::default()));
    {
        let mut state = tree.lock().unwrap();
        state.files.insert("/file".into(), b"data".to_vec());
        state.files.insert("/link".into(), Vec::new());
        state.modes.insert("/link".into(), 0o120777);
        state.directories.insert("/directory".into());
    }
    let observer = client(tree.clone(), None).await;
    let endpoint = |path: &str| Endpoint {
        session: Some("remote".into()),
        path: path.into(),
    };
    assert_eq!(
        file_length(&endpoint("/file"), Some(&observer))
            .await
            .unwrap(),
        Some(4)
    );
    assert_eq!(
        file_length(&endpoint("/missing"), Some(&observer))
            .await
            .unwrap(),
        None
    );
    assert!(
        matches!(file_length(&endpoint("/link"), Some(&observer)).await,
        Err(AppError::Validation(error)) if error == "sftp.symlinkUnsupported")
    );
    assert!(
        matches!(file_length(&endpoint("/directory"), Some(&observer)).await,
        Err(AppError::Validation(error)) if error == "sftp.typeConflict")
    );
    assert_eq!(tree.lock().unwrap().lstats, 4);
    observer.close().await.unwrap();
}

#[tokio::test]
async fn lost_mkdir_reply_keeps_the_uncertain_creation_for_review() {
    let to = Endpoint {
        session: Some("remote".into()),
        path: "/target".into(),
    };
    let mut saved = record(&to);
    if let ArtifactRecord::Current {
        staging: Some(staging),
        ..
    } = &mut saved
    {
        staging.prepared = false;
        staging.opening = false;
        staging.creating = true;
    }
    let restored: ArtifactRecord =
        serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
    let directory =
        staging_directory(&to, "job", remote_staging(Some(&restored)).unwrap()).unwrap();
    let tree = Arc::new(Mutex::new(Tree::default()));
    let observer = client(tree.clone(), None).await;
    let gate = Arc::new(Gate {
        before_create: false,
        arrived: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
        finished: tokio::sync::Semaphore::new(0),
    });
    let data = directory_client(tree.clone(), Some(gate.clone())).await;
    let data_ref = &data;
    let cancel = AtomicBool::new(false);
    tokio::select! {
        result = ensure_private_directory(&observer, &directory, &cancel, |path| async move {
            data_ref.create_private_directory(&path.path).await?.into_result()
        }) => panic!("MKDIR acknowledgement should be withheld: {result:?}"),
        permit = gate.arrived.acquire() => permit.unwrap().forget(),
    }
    drop(data); // Simulate termination before the private-directory checkpoint.
    assert_eq!(tree.lock().unwrap().modes[&directory.path], 0o40700);
    assert!(matches!(
        require_creation_settled("job", &to, Some(&restored)),
        Err(AppError::TransferCreationUnconfirmed { ref path }) if path == &directory.path
    ));
    assert!(cleanup_directory(&observer, &directory, true)
        .await
        .is_err());
    assert!(tree.lock().unwrap().directories.contains(&directory.path));
    gate.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(1), gate.finished.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    // Even an empty directory is retained until the creation is acknowledged.
    assert!(tree.lock().unwrap().directories.contains(&directory.path));
    observer.close().await.unwrap();
}

#[tokio::test]
async fn directory_recovery_preserves_foreign_types_permissions_and_contents() {
    for (is_directory, mode, contents) in [
        (false, 0o100600, 0),
        (true, 0o120700, 0),
        (true, 0o40755, 0),
        (true, 0o40700, 1),
        (true, 0o40700, 2),
    ] {
        let tree = Arc::new(Mutex::new(Tree::default()));
        let directory = Endpoint {
            session: Some("remote".into()),
            path: "/private-stage".into(),
        };
        {
            let mut state = tree.lock().unwrap();
            if is_directory {
                state.directories.insert(directory.path.clone());
                state.modes.insert(directory.path.clone(), mode);
            } else {
                state
                    .files
                    .insert(directory.path.clone(), b"foreign".to_vec());
            }
            if contents == 1 {
                state
                    .files
                    .insert(directory.path.clone() + "/foreign", b"preserve".to_vec());
            } else if contents == 2 {
                state
                    .directories
                    .insert(directory.path.clone() + "/foreign");
            }
        }
        let observer = client(tree.clone(), None).await;
        let before = {
            let state = tree.lock().unwrap();
            (
                state.directories.clone(),
                state.files.clone(),
                state.modes.clone(),
            )
        };
        assert!(matches!(
            ensure_private_directory(&observer, &directory, &AtomicBool::new(false), |_| async {
                panic!("Existing foreign paths must never be modified")
            })
            .await,
            Err(AppError::TransferArtifactUnrecognized { .. })
        ));
        {
            let state = tree.lock().unwrap();
            assert_eq!(
                before,
                (
                    state.directories.clone(),
                    state.files.clone(),
                    state.modes.clone()
                )
            );
        }
        observer.close().await.unwrap();
    }
}

fn record(to: &Endpoint) -> ArtifactRecord {
    ArtifactRecord::Current {
        path: to.path.clone(),
        identity: None,
        archive: None,
        publication: None,
        staging: Some(RemoteStaging {
            generation: uuid::Uuid::new_v4().to_string(),
            prepared: true,
            opening: true,
            creating: false,
        }),
    }
}

async fn cancelled_create(before_create: bool) {
    let to = Endpoint {
        session: Some("remote".into()),
        path: "/target".into(),
    };
    let saved = record(&to);
    // A restart must retain the uncertain opening and the exact parent generation.
    let restored: ArtifactRecord =
        serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
    let directory =
        staging_directory(&to, "job", remote_staging(Some(&restored)).unwrap()).unwrap();
    let part = part_from_record(&to, "job", Some(&restored)).unwrap();
    let tree = Arc::new(Mutex::new(Tree::default()));
    tree.lock()
        .unwrap()
        .directories
        .insert(directory.path.clone());
    let gate = Arc::new(Gate {
        before_create,
        arrived: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
        finished: tokio::sync::Semaphore::new(0),
    });
    let writer = client(tree.clone(), Some(gate.clone())).await;
    let observer = client(tree.clone(), None).await;
    let cancel = AtomicBool::new(false);
    let observation = Default::default();
    let result = tokio::join!(
        interruptible(
            Some(&cancel),
            create_writer(&part, Some(&writer), false, &observation)
        ),
        async {
            gate.arrived.acquire().await.unwrap().forget();
            cancel.store(true, Ordering::SeqCst);
        }
    )
    .0;
    assert!(matches!(result, Err(AppError::Ssh(error)) if error == CANCELLED));
    tokio::time::timeout(
        Duration::from_secs(1),
        retire_remote_staging("job", &to, &observer, &restored, &AtomicBool::new(false)),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!tree.lock().unwrap().directories.contains(&directory.path));
    // Resume uses another private directory, and its complete contents survive
    // execution/reply of the old CREATE on the still-live original connection.
    let new_record = record(&to);
    let new_part = part_from_record(&to, "job", Some(&new_record)).unwrap();
    let new_directory =
        staging_directory(&to, "job", remote_staging(Some(&new_record)).unwrap()).unwrap();
    tree.lock().unwrap().directories.insert(new_directory.path);
    tree.lock()
        .unwrap()
        .files
        .insert(new_part.path.clone(), b"resumed contents".to_vec());
    gate.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(1), gate.finished.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert!(!tree.lock().unwrap().files.contains_key(&part.path));
    assert_eq!(
        tree.lock().unwrap().files.get(&new_part.path).unwrap(),
        b"resumed contents"
    );
    // Repeated cleanup after a lost RMDIR acknowledgement is idempotent.
    retire_remote_staging("job", &to, &observer, &restored, &AtomicBool::new(false))
        .await
        .unwrap();
    writer.close().await.unwrap();
    observer.close().await.unwrap();
}

#[tokio::test]
async fn delayed_create_cannot_recreate_a_retired_parent_after_resume() {
    cancelled_create(true).await
}

#[tokio::test]
async fn lost_create_reply_does_not_reuse_or_leak_the_old_staging_file() {
    cancelled_create(false).await
}

#[tokio::test]
async fn uncertain_creation_cleanup_preserves_nonempty_or_foreign_files() {
    let to = Endpoint {
        session: Some("remote".into()),
        path: "/target".into(),
    };
    let saved = record(&to);
    let directory = staging_directory(&to, "job", remote_staging(Some(&saved)).unwrap()).unwrap();
    let part = part_from_record(&to, "job", Some(&saved)).unwrap();
    let tree = Arc::new(Mutex::new(Tree::default()));
    tree.lock()
        .unwrap()
        .directories
        .insert(directory.path.clone());
    tree.lock()
        .unwrap()
        .files
        .insert(part.path.clone(), b"unexpected data".to_vec());
    let observer = client(tree.clone(), None).await;
    assert!(matches!(
        retire_remote_staging("job", &to, &observer, &saved, &AtomicBool::new(false)).await,
        Err(AppError::TransferArtifactUnrecognized { .. })
    ));
    assert_eq!(
        tree.lock().unwrap().files.get(&part.path).unwrap(),
        b"unexpected data"
    );
    tree.lock().unwrap().files.remove(&part.path);
    let foreign = directory.path.clone() + "/unrelated";
    tree.lock()
        .unwrap()
        .files
        .insert(foreign.clone(), b"preserve".to_vec());
    assert!(
        retire_remote_staging("job", &to, &observer, &saved, &AtomicBool::new(false))
            .await
            .is_err()
    );
    assert_eq!(
        tree.lock().unwrap().files.get(&foreign).unwrap(),
        b"preserve"
    );
    assert!(tree.lock().unwrap().directories.contains(&directory.path));
    observer.close().await.unwrap();
}

#[test]
fn staging_generations_preserve_archive_and_publication_paths() {
    let to = Endpoint {
        session: Some("remote".into()),
        path: "/home/文件.txt".into(),
    };
    let mut saved = record(&to);
    let first = part_from_record(&to, "job", Some(&saved)).unwrap();
    let generation = uuid::Uuid::new_v4().to_string();
    let next = publication_successor(&to, "job", &generation, Some(&saved)).unwrap();
    assert_ne!(first.path, next.path);
    assert_eq!(
        first.path.rsplit_once('/').unwrap().0,
        next.path.rsplit_once('/').unwrap().0
    );
    if let ArtifactRecord::Current { archive, .. } = &mut saved {
        *archive = Some(ArchiveWrite {
            generation: Some(generation),
            pending: true,
        });
    }
    assert_eq!(
        part_from_record(&to, "job", Some(&saved)).unwrap().path,
        next.path
    );
    if let ArtifactRecord::Current {
        staging: Some(staging),
        ..
    } = &mut saved
    {
        staging.generation = "../invalid".into();
    }
    assert!(part_from_record(&to, "job", Some(&saved)).is_err());
}

#[tokio::test]
async fn cleanup_cannot_forget_a_directory_created_after_its_missing_path_check() {
    let tree = Arc::new(Mutex::new(Tree::default()));
    let observer = client(tree.clone(), None).await;
    let gate = Arc::new(Gate {
        before_create: true,
        arrived: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
        finished: tokio::sync::Semaphore::new(0),
    });
    let data = directory_client(tree.clone(), Some(gate.clone())).await;
    let directory = Endpoint {
        session: Some("remote".into()),
        path: "/private-stage".into(),
    };
    let creation = data.create_private_directory(&directory.path);
    tokio::pin!(creation);
    tokio::select! {
        result = &mut creation => panic!("MKDIR should still be queued: {result:?}"),
        permit = gate.arrived.acquire() => permit.unwrap().forget(),
    }
    assert!(!tree.lock().unwrap().directories.contains(&directory.path));
    let result = cleanup_directory(&observer, &directory, true).await;
    // The server can still execute its queued MKDIR after our missing-path check.
    gate.release.add_permits(1);
    creation.await.unwrap().into_result().unwrap();
    assert!(tree.lock().unwrap().directories.contains(&directory.path));
    cleanup_directory(&observer, &directory, false)
        .await
        .unwrap();
    assert!(!tree.lock().unwrap().directories.contains(&directory.path));
    observer.close().await.unwrap();
    assert!(
        matches!(result, Err(AppError::TransferCreationUnconfirmed {ref path}) if path == &directory.path),
        "Unacknowledged MKDIR must keep its recovery journal: {result:?}"
    );
}

#[test]
fn historical_unprepared_journals_never_assume_the_create_was_unsent() {
    let to = Endpoint {
        session: Some("remote".into()),
        path: "/target".into(),
    };
    for prepared in [false, true] {
        let raw = serde_json::json!({
            "path":to.path,"identity":null,
            "staging":{"generation":uuid::Uuid::new_v4().to_string(),"prepared":prepared,"opening":false}
        });
        let saved: ArtifactRecord = serde_json::from_value(raw).unwrap();
        assert_eq!(
            require_creation_settled("job", &to, Some(&saved)).is_ok(),
            prepared
        );
        let restored: ArtifactRecord =
            serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
        assert_eq!(
            require_creation_settled("job", &to, Some(&restored)).is_ok(),
            prepared
        );
    }
    let mut saved = record(&to);
    if let ArtifactRecord::Current {
        staging: Some(staging),
        ..
    } = &mut saved
    {
        staging.prepared = false;
        staging.opening = false;
        staging.creating = false;
    }
    assert!(require_creation_settled("job", &to, Some(&saved)).is_ok());
}

#[tokio::test]
async fn acknowledged_directory_cleanup_is_retryable_and_keeps_foreign_contents() {
    let tree = Arc::new(Mutex::new(Tree::default()));
    let observer = client(tree.clone(), None).await;
    let directory = Endpoint {
        session: Some("remote".into()),
        path: "/private-stage".into(),
    };
    tree.lock()
        .unwrap()
        .directories
        .insert(directory.path.clone());
    let foreign = directory.path.clone() + "/foreign";
    tree.lock()
        .unwrap()
        .files
        .insert(foreign.clone(), b"keep".to_vec());
    assert!(cleanup_directory(&observer, &directory, false)
        .await
        .is_err());
    assert_eq!(tree.lock().unwrap().files[&foreign], b"keep");
    tree.lock().unwrap().files.remove(&foreign);
    cleanup_directory(&observer, &directory, false)
        .await
        .unwrap();
    // A lost successful RMDIR reply may be retried without a journal leak.
    cleanup_directory(&observer, &directory, false)
        .await
        .unwrap();
    assert!(!tree.lock().unwrap().directories.contains(&directory.path));
    observer.close().await.unwrap();
}

#[tokio::test]
async fn acknowledged_mkdir_rejections_are_distinct_from_unconfirmed_transport_errors() {
    let tree = Arc::new(Mutex::new(Tree::default()));
    tree.lock().unwrap().directories.insert("/existing".into());
    let data = directory_client(tree, None).await;
    let reply = data.create_private_directory("/existing").await.unwrap();
    assert!(matches!(reply, range_io::DirectoryCreation::Rejected(_)));
    assert!(reply.into_result().is_err());
}
