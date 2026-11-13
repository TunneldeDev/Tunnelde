use super::*;
use contracts::{Record, Settlement, MAX_PER_TRANSFER, PREFIX};
use rusqlite::Connection;

fn fixture() -> (Connection, Endpoint, ArtifactRecord) {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)").unwrap();
    let to = Endpoint {
        session: Some("new-session".into()),
        path: "/downloads/数据.bin".into(),
    };
    let artifact = ArtifactRecord::Current {
        path: to.path.clone(),
        identity: None,
        archive: None,
        publication: None,
        staging: Some(RemoteStaging {
            generation: uuid::Uuid::new_v4().to_string(),
            prepared: false,
            opening: false,
            creating: true,
        }),
    };
    let task: durable::DurableTransfer = serde_json::from_value(serde_json::json!({
        "id":"job", "direction":"transfer", "name":"数据.bin",
        "fromSession":null,"fromHostId":null,"fromPath":"C:/source",
        "toSession":"old-session","toHostId":"host","toAddress":"user@server:22","toPath":"/downloads/数据.bin",
        "removeSource":false,"overwrite":false,"transferred":0,"total":123,"status":"running","error":null,"updatedAt":1
    })).unwrap();
    conn.execute(
        "INSERT INTO settings VALUES(?1,?2,1)",
        rusqlite::params!["transfer:job", serde_json::to_string(&task).unwrap()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO settings VALUES(?1,?2,1)",
        rusqlite::params![
            artifact_key("job", &to),
            serde_json::to_string(&artifact).unwrap()
        ],
    )
    .unwrap();
    (conn, to, artifact)
}

fn retained(conn: &Connection) -> Vec<Record> {
    let mut query = conn
        .prepare("SELECT value FROM settings WHERE instr(key,?1)=1 ORDER BY key")
        .unwrap();
    query
        .query_map([PREFIX], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|raw| serde_json::from_str(&raw.unwrap()).unwrap())
        .collect()
}

fn active(conn: &Connection, to: &Endpoint) -> ArtifactRecord {
    let raw: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [artifact_key("job", to)],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

fn task(conn: &Connection, id: &str) -> durable::DurableTransfer {
    let raw: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [format!("transfer:{id}")],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn malformed_identity_and_owner_indices_never_grant_cleanup_authority() {
    let (conn, to, old) = fixture();
    journal::rotate(&conn, "job", &to, &old, ("host", "user@server:22")).unwrap();
    let record = retained(&conn).pop().unwrap();
    for parent in ["../other", "nested/job", "job:other", "job\n"] {
        let mut changed = record.clone();
        changed.parent_id = parent.into();
        let endpoint = Endpoint {
            session: to.session.clone(),
            path: record.target.clone(),
        };
        let staging = RemoteStaging {
            generation: record.generation.clone(),
            prepared: false,
            opening: false,
            creating: true,
        };
        changed.directory = staging_directory(&endpoint, parent, &staging).unwrap().path;
        assert!(changed.validate().is_err());
    }
    conn.execute(
        "UPDATE settings SET value='other' WHERE key=?1",
        [record.owner_key()],
    )
    .unwrap();
    assert!(journal::load(&conn, &record.task_id).is_err());
    assert!(journal::restore_tasks(&conn).is_err());
    assert!(journal::remove(&conn, &record).is_err());
    assert_eq!(retained(&conn).len(), 1);
}

#[test]
fn settlement_is_authoritative_over_stale_cleanup_snapshots_and_colliding_task_rows() {
    let (conn, to, old) = fixture();
    journal::rotate(&conn, "job", &to, &old, ("host", "user@server:22")).unwrap();
    let record = retained(&conn).pop().unwrap();
    let mut stale = task(&conn, &record.task_id);
    let directory = Endpoint {
        session: to.session.clone(),
        path: record.directory.clone(),
    };
    journal::settle(&conn, "job", &to, &directory, true).unwrap();
    stale.error = Some("sftp.transferCreationUnconfirmed".into());
    stale.updated_at += 100;
    journal::update_task(&conn, &stale).unwrap();
    let settled = task(&conn, &record.task_id);
    assert_eq!(settled.retained_settlement.as_deref(), Some("created"));
    assert_eq!(
        settled.error.as_deref(),
        Some("sftp.retainedCreationSettled")
    );
    let mut failed = settled;
    failed.error = Some("Permission denied".into());
    journal::update_task(&conn, &failed).unwrap();
    journal::restore_tasks(&conn).unwrap();
    assert_eq!(task(&conn, &record.task_id).error, failed.error);
    journal::update_task(&conn, &stale).unwrap();
    assert_eq!(task(&conn, &record.task_id).error, failed.error);
    // Corrupt UI projection alone must be repaired from the receipt.
    conn.execute(
        "UPDATE settings SET value=json_set(value,'$.retainedSettlement','unknown') WHERE key=?1",
        [format!("transfer:{}", record.task_id)],
    )
    .unwrap();
    journal::restore_tasks(&conn).unwrap();
    assert_eq!(
        task(&conn, &record.task_id).error.as_deref(),
        Some("sftp.retainedCreationSettled")
    );
    // A conflicting normal task is not replaced with a recovery projection.
    conn.execute(
        "UPDATE settings SET value=json_set(value,'$.retainedCreation',json('false')) WHERE key=?1",
        [format!("transfer:{}", record.task_id)],
    )
    .unwrap();
    assert!(journal::restore_tasks(&conn).is_err());
    assert!(!task(&conn, &record.task_id).retained_creation);
    conn.execute(
        "DELETE FROM settings WHERE key=?1",
        [format!("transfer:{}", record.task_id)],
    )
    .unwrap();
    journal::restore_tasks(&conn).unwrap();
    let settled = journal::load(&conn, &record.task_id).unwrap().unwrap();
    journal::remove(&conn, &settled).unwrap();
    journal::update_task(&conn, &stale).unwrap();
    assert!(conn
        .query_row::<String, _, _>(
            "SELECT value FROM settings WHERE key=?1",
            [format!("transfer:{}", record.task_id)],
            |r| r.get(0)
        )
        .optional()
        .unwrap()
        .is_none());
}

#[test]
fn peer_changes_and_foreign_target_never_publish_a_rotation() {
    for (host, address, path) in [
        ("other", "user@server:22", "/downloads/数据.bin"),
        ("host", "other@server:22", "/downloads/数据.bin"),
        ("host", "user@server:23", "/downloads/数据.bin"),
        ("host", "user@server:22", "/other"),
    ] {
        let (conn, mut to, old) = fixture();
        to.path = path.into();
        assert!(journal::rotate(&conn, "job", &to, &old, (host, address)).is_err());
        assert!(retained(&conn).is_empty());
    }
}

#[test]
fn synced_retention_and_late_settlement_survive_sqlite_reopen() {
    let directory =
        std::env::temp_dir().join(format!("tunnelde-retained-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("retained.sqlite");
    let (source, to, old) = fixture();
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL); CREATE TRIGGER require_full BEFORE INSERT ON settings WHEN instr(NEW.key,'transfer-retained-creation:')=1 AND (SELECT synchronous FROM pragma_synchronous)<2 BEGIN SELECT RAISE(ABORT,'not durable'); END;").unwrap();
    let mut query = source
        .prepare("SELECT key,value,updated_at FROM settings")
        .unwrap();
    for row in query
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
    {
        let (k, v, t) = row.unwrap();
        conn.execute(
            "INSERT INTO settings VALUES(?1,?2,?3)",
            rusqlite::params![k, v, t],
        )
        .unwrap();
    }
    journal::rotate(&conn, "job", &to, &old, ("host", "user@server:22")).unwrap();
    let record = retained(&conn).pop().unwrap();
    assert_eq!(
        conn.pragma_query_value::<i64, _>(None, "synchronous", |r| r.get(0))
            .unwrap(),
        1
    );
    drop(conn);
    let conn = Connection::open(&path).unwrap();
    assert_eq!(retained(&conn).len(), 1);
    let endpoint = Endpoint {
        session: to.session.clone(),
        path: record.directory.clone(),
    };
    assert!(journal::settle(&conn, "job", &to, &endpoint, false).unwrap());
    drop(conn);
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        journal::load(&conn, &record.task_id)
            .unwrap()
            .unwrap()
            .settlement,
        Settlement::Rejected
    );
    assert_eq!(
        task(&conn, &record.task_id).retained_settlement.as_deref(),
        Some("rejected")
    );
    drop(conn);
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_dir(&directory).unwrap();
}

#[test]
fn global_bound_and_malformed_receipts_fail_closed_without_discarding_the_active_generation() {
    let (conn, to, old) = fixture();
    for index in 0..contracts::MAX_TOTAL {
        conn.execute(
            "INSERT INTO settings VALUES(?1,'{}',1)",
            [format!("{PREFIX}placeholder-{index}")],
        )
        .unwrap();
    }
    assert_eq!(
        journal::rotate(&conn, "job", &to, &old, ("host", "user@server:22"))
            .err()
            .unwrap()
            .to_string(),
        "sftp.retainedCreationLimit"
    );
    assert!(journal::restore_tasks(&conn).is_err());
    assert_eq!(
        serde_json::to_value(active(&conn, &to)).unwrap(),
        serde_json::to_value(old).unwrap()
    );
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM settings WHERE instr(key,?1)=1",
            [PREFIX],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, contracts::MAX_TOTAL as i64);
}

#[tokio::test]
async fn late_protocol_success_cleans_only_its_old_empty_directory_after_rotation() {
    use super::super::test_support::{client, directory_client, Gate, Tree};
    use std::{sync::Mutex, time::Duration};
    for before_create in [true, false] {
        let (conn, to, old) = fixture();
        let tree = Arc::new(Mutex::new(Tree::default()));
        let gate = Arc::new(Gate {
            before_create,
            arrived: tokio::sync::Semaphore::new(0),
            release: tokio::sync::Semaphore::new(0),
            finished: tokio::sync::Semaphore::new(0),
        });
        let data = directory_client(tree.clone(), Some(gate.clone())).await;
        let observer = client(tree.clone(), None).await;
        let path = staging_directory(&to, "job", remote_staging(Some(&old)).unwrap()).unwrap();
        let creation = data.create_private_directory(&path.path);
        tokio::pin!(creation);
        tokio::select! { result=&mut creation=>panic!("unexpected early reply: {result:?}"),permit=gate.arrived.acquire()=>permit.unwrap().forget() }
        let next = journal::rotate(&conn, "job", &to, &old, ("host", "user@server:22")).unwrap();
        let record = retained(&conn).pop().unwrap();
        assert!(journal::remove(&conn, &record).is_err());
        let fresh = staging_directory(&to, "job", remote_staging(Some(&next)).unwrap()).unwrap();
        observer.create_dir(&fresh.path).await.unwrap();
        gate.release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), creation)
            .await
            .unwrap()
            .unwrap()
            .into_result()
            .unwrap();
        assert!(super::super::staging::settle_creation(&conn, "job", &to, &path, true).unwrap());
        assert_eq!(
            serde_json::to_value(active(&conn, &to)).unwrap(),
            serde_json::to_value(next).unwrap()
        );
        cleanup_created(
            &observer,
            &record.directory,
            &native_save::runtime::MutationObservation::default(),
        )
        .await
        .unwrap();
        assert!(!tree.lock().unwrap().directories.contains(&path.path));
        assert!(tree.lock().unwrap().directories.contains(&fresh.path));
        journal::remove(
            &conn,
            &journal::load(&conn, &record.task_id).unwrap().unwrap(),
        )
        .unwrap();
        observer.close().await.unwrap();
    }
}

#[tokio::test]
async fn acknowledged_cleanup_preserves_foreign_contents_types_and_permissions() {
    use super::super::test_support::{client, Tree};
    use std::sync::Mutex;
    for kind in [
        "file",
        "symlink",
        "public-directory",
        "nonempty",
        "missing",
        "empty",
    ] {
        let tree = Arc::new(Mutex::new(Tree::default()));
        {
            let mut tree = tree.lock().unwrap();
            match kind {
                "file" | "symlink" => {
                    tree.files.insert("/old".into(), b"preserve".to_vec());
                    if kind == "symlink" {
                        tree.modes.insert("/old".into(), 0o120700);
                    }
                }
                "missing" => {}
                _ => {
                    tree.directories.insert("/old".into());
                    if kind == "public-directory" {
                        tree.modes.insert("/old".into(), 0o40755);
                    }
                    if kind == "nonempty" {
                        tree.files
                            .insert("/old/foreign".into(), b"preserve".to_vec());
                    }
                }
            }
        }
        let observer = client(tree.clone(), None).await;
        assert_eq!(
            cleanup_created(
                &observer,
                "/old",
                &native_save::runtime::MutationObservation::default()
            )
            .await
            .is_ok(),
            matches!(kind, "missing" | "empty"),
            "{kind}"
        );
        if matches!(kind, "file" | "symlink") {
            assert_eq!(tree.lock().unwrap().files["/old"], b"preserve");
        }
        if kind == "nonempty" {
            assert_eq!(tree.lock().unwrap().files["/old/foreign"], b"preserve");
        }
        observer.close().await.unwrap();
    }
}

#[test]
fn retirement_atomically_retains_old_intent_and_assigns_a_fresh_unsent_generation() {
    let (conn, to, old) = fixture();
    let before: i64 = conn
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .unwrap();
    let next = journal::rotate(&conn, "job", &to, &old, ("host", "user@server:22")).unwrap();
    let saved = retained(&conn);
    assert_eq!(saved.len(), 1);
    let record = &saved[0];
    record.validate().unwrap();
    assert_eq!(
        record.generation,
        remote_staging(Some(&old)).unwrap().generation
    );
    assert_ne!(
        record.generation,
        remote_staging(Some(&next)).unwrap().generation
    );
    assert_eq!(record.settlement, Settlement::Unknown);
    let new_stage = remote_staging(Some(&next)).unwrap();
    assert!(!new_stage.creating && !new_stage.prepared && !new_stage.opening);
    let restored: durable::DurableTransfer = serde_json::from_str(
        &conn
            .query_row::<String, _, _>(
                "SELECT value FROM settings WHERE key=?1",
                [format!("transfer:{}", record.task_id)],
                |row| row.get(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert!(restored.retained_creation);
    assert_eq!(restored.to_host_id.as_deref(), Some("host"));
    assert_eq!(restored.to_address.as_deref(), Some("user@server:22"));
    assert_eq!(
        restored.artifact_recovery.as_deref(),
        Some(record.directory.as_str())
    );
    assert!(!restored.remove_source);
    assert!(restored.require_user_control().is_err());
    assert_eq!(
        before,
        conn.pragma_query_value::<i64, _>(None, "synchronous", |row| row.get(0))
            .unwrap()
    );
    assert!(journal::remove(&conn, record).is_err());
    assert!(protect_remove(&conn, &record.task_id).is_err());
}

#[test]
fn journal_failure_rolls_back_the_rotation_receipt_task_and_checkpoint_changes() {
    let (conn, to, old) = fixture();
    conn.execute_batch("CREATE TRIGGER fail_receipt BEFORE INSERT ON settings WHEN instr(NEW.key,'transfer-retained-owner:')=1 BEGIN SELECT RAISE(ABORT,'injected full disk'); END;").unwrap();
    assert!(journal::rotate(&conn, "job", &to, &old, ("host", "user@server:22")).is_err());
    assert!(retained(&conn).is_empty());
    assert_eq!(
        serde_json::to_value(active(&conn, &to)).unwrap(),
        serde_json::to_value(old).unwrap()
    );
    assert_eq!(
        conn.query_row::<i64, _, _>("SELECT count(*) FROM settings", [], |row| row.get(0))
            .unwrap(),
        2
    );
    assert!(conn.is_autocommit());
}

#[test]
fn stale_or_invalid_rotation_never_publishes_retained_authority() {
    for mutation in [
        "stale",
        "identity",
        "prepared",
        "opening",
        "publication",
        "archive",
        "host",
        "address",
        "done",
        "retained",
    ] {
        let (conn, to, old) = fixture();
        match mutation {
            "stale" => {
                conn.execute("UPDATE settings SET value=json_set(value,'$.staging.generation',?1) WHERE key=?2",rusqlite::params![uuid::Uuid::new_v4().to_string(),artifact_key("job",&to)]).unwrap();
            }
            "host" | "address" => {
                conn.execute(
                    "UPDATE settings SET value=json_remove(value,?1) WHERE key='transfer:job'",
                    [if mutation == "host" {
                        "$.toHostId"
                    } else {
                        "$.toAddress"
                    }],
                )
                .unwrap();
            }
            "done" => {
                conn.execute("UPDATE settings SET value=json_set(value,'$.status','done') WHERE key='transfer:job'",[]).unwrap();
            }
            "retained" => {
                conn.execute("UPDATE settings SET value=json_set(value,'$.retainedCreation',json('true')) WHERE key='transfer:job'",[]).unwrap();
            }
            _ => {
                let mut raw = serde_json::to_value(&old).unwrap();
                match mutation {
                    "identity" => {
                        raw["identity"] = serde_json::json!({"platform":"windows","volume":1,"index":vec![0;16],"created":1})
                    }
                    "prepared" => raw["staging"]["prepared"] = true.into(),
                    "opening" => raw["staging"]["opening"] = true.into(),
                    "publication" => raw["publication"] = serde_json::json!({"successor":null}),
                    "archive" => {
                        raw["archive"] = serde_json::json!({"generation":null,"pending":true})
                    }
                    _ => unreachable!(),
                };
                conn.execute(
                    "UPDATE settings SET value=?1 WHERE key=?2",
                    rusqlite::params![
                        serde_json::to_string(&raw).unwrap(),
                        artifact_key("job", &to)
                    ],
                )
                .unwrap();
            }
        }
        let expected = if mutation == "stale" {
            old
        } else {
            active(&conn, &to)
        };
        assert!(
            journal::rotate(&conn, "job", &to, &expected, ("host", "user@server:22")).is_err(),
            "{mutation}"
        );
        assert!(retained(&conn).is_empty(), "{mutation}");
    }
}

#[test]
fn late_receipts_settle_only_their_retained_generation_even_after_the_parent_is_removed() {
    for created in [true, false] {
        let (conn, to, old) = fixture();
        let directory = staging_directory(&to, "job", remote_staging(Some(&old)).unwrap()).unwrap();
        let next = journal::rotate(&conn, "job", &to, &old, ("host", "user@server:22")).unwrap();
        let record = retained(&conn).pop().unwrap();
        // Original transfer/checkpoints may disappear; retained keys are separate.
        conn.execute(
            "DELETE FROM settings WHERE key='transfer:job' OR key=?1",
            [artifact_key("job", &to)],
        )
        .unwrap();
        let wrong = Endpoint {
            path: "/other".into(),
            session: to.session.clone(),
        };
        assert!(journal::settle(&conn, "job", &wrong, &directory, created).is_err());
        assert!(!journal::settle(&conn, "other", &to, &directory, created).unwrap());
        assert!(journal::settle(&conn, "job", &to, &directory, created).unwrap());
        let done = journal::load(&conn, &record.task_id).unwrap().unwrap();
        assert_eq!(
            done.settlement,
            if created {
                Settlement::Created
            } else {
                Settlement::Rejected
            }
        );
        assert!(!journal::settle(&conn, "job", &to, &directory, !created).unwrap());
        journal::remove(&conn, &done).unwrap();
        assert!(retained(&conn).is_empty());
        assert!(!journal::settle(&conn, "job", &to, &directory, created).unwrap());
        assert!(journal::load(&conn, &record.task_id).unwrap().is_none());
        assert_ne!(
            remote_staging(Some(&next)).unwrap().generation,
            record.generation
        );
    }
}

#[test]
fn retained_work_survives_ui_row_removal_and_limits_bound_unacknowledged_generations() {
    let (conn, to, mut old) = fixture();
    for index in 0..MAX_PER_TRANSFER {
        let next = journal::rotate(&conn, "job", &to, &old, ("host", "user@server:22")).unwrap();
        let record = retained(&conn)
            .into_iter()
            .find(|r| r.generation == remote_staging(Some(&old)).unwrap().generation)
            .unwrap();
        conn.execute(
            "DELETE FROM settings WHERE key=?1",
            [format!("transfer:{}", record.task_id)],
        )
        .unwrap();
        journal::restore_tasks(&conn).unwrap();
        let task: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key=?1",
                [format!("transfer:{}", record.task_id)],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            serde_json::from_str::<durable::DurableTransfer>(&task)
                .unwrap()
                .retained_creation
        );
        assert_eq!(retained(&conn).len(), index + 1);
        let mut next = serde_json::to_value(next).unwrap();
        next["staging"]["creating"] = true.into();
        conn.execute(
            "UPDATE settings SET value=?1 WHERE key=?2",
            rusqlite::params![
                serde_json::to_string(&next).unwrap(),
                artifact_key("job", &to)
            ],
        )
        .unwrap();
        old = serde_json::from_value(next).unwrap();
    }
    assert_eq!(
        journal::rotate(&conn, "job", &to, &old, ("host", "user@server:22"))
            .err()
            .unwrap()
            .to_string(),
        "sftp.retainedCreationLimit"
    );
    assert_eq!(retained(&conn).len(), MAX_PER_TRANSFER);
    assert_eq!(
        serde_json::to_value(active(&conn, &to)).unwrap(),
        serde_json::to_value(old).unwrap()
    );
}
