//! Actual registry + private journal + application projection terminal handoff.
use super::mutation::{journal, setup};
use super::transfer_worker::{database, task};
use super::*;
use crate::ssh::files::native_save::{
    journal::admission::{Phase, TransferOutcome},
    runtime::MutationTarget,
};
use crate::ssh::files::{
    transfer_ownership::{self, checkpoint, terminal::project},
    TransferRegistry,
};

#[tokio::test]
async fn terminal_projection_failure_survives_reopen_and_retirement_never_authorizes_replay() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(
        &[
            ("/requested", Ok("/workspace/actual")),
            ("/workspace/actual", Ok("/workspace/actual")),
        ],
        None,
    )
    .await;
    let task = task(&destination);
    let paths = vec!["/requested".into()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &paths,
    }];
    let registry = TransferRegistry::default();
    registry
        .register(&task.id, Arc::new(AtomicBool::new(false)), None)
        .unwrap();
    let observation = registry.observation(&task.id).unwrap();
    let ownership = registry.ownership(&task.id).unwrap();
    let conn = database();
    transfer_ownership::admit(
        &manager,
        &ownership,
        task.clone(),
        &targets,
        observation.clone(),
        (false, |reference| {
            checkpoint::link(&conn, &task.id, reference)
        }),
        || Ok(()),
    )
    .await
    .unwrap();
    // A real protocol rejection confirms that the attempted MKDIR created no
    // artifact; disposal of this empty task can now seal its original epoch.
    assert!(observation
        .request(sftp.create_dir("/requested"))
        .await
        .is_err());
    let terminal = ownership
        .lock()
        .await
        .as_mut()
        .unwrap()
        .complete(TransferOutcome::Disposed)
        .await
        .unwrap();
    assert!(observation.closed() && observation.begin().is_none());
    let failed = manager
        .project_transfer_terminal(&terminal, |_| {
            Err(crate::error::AppError::validation("injected disk failure"))
        })
        .await;
    assert!(failed.is_err());
    assert!(journal(&fixture).legacy_claims().unwrap()[0].phase == Phase::Terminal);
    assert!(manager.transfer_task_reference(&task).await.is_err());
    assert!(manager
        .writable(&destination, &sftp, &["/requested"])
        .await
        .is_err());
    drop(manager);
    let manager = fixture.manager();
    let terminal = manager.transfer_terminals().await.unwrap().pop().unwrap();
    manager
        .project_transfer_terminal(&terminal, |terminal| project(&conn, terminal))
        .await
        .unwrap();
    let raw: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [format!("transfer:{}", task.id)],
            |row| row.get(0),
        )
        .unwrap();
    let projected: crate::ssh::files::durable::DurableTransfer =
        serde_json::from_str(&raw).unwrap();
    assert_eq!(projected.status, "cancelled");
    assert_eq!(projected.to_path, task.destination.path);
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    manager
        .writable(&destination, &sftp, &["/requested"])
        .await
        .unwrap();
    // The stale app link remains a replay fence after private retirement. Its
    // presence cannot recreate a missing original or mint a new dispatch.
    assert!(checkpoint::exists(&conn, &task.id).unwrap());
    assert!(transfer_ownership::admit(
        &manager,
        &transfer_ownership::Shared::default(),
        task.clone(),
        &targets,
        MutationObservation::default(),
        (true, |_| Ok(())),
        || Ok(())
    )
    .await
    .is_err());
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    registry.release(&task.id);
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn terminal_projection_is_atomic_and_preserves_original_intent_on_conflict() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(&[("/requested", Ok("/workspace/actual"))], None).await;
    let task = task(&destination);
    let paths = vec!["/requested".into()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &paths,
    }];
    let reserved = manager
        .reserve_transfer_task(&targets, task.clone(), &uuid::Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    drop(reserved);
    let terminal = manager.dispose_empty_task(&task.id).await.unwrap().unwrap();
    let conn = database();
    conn.execute_batch("CREATE TRIGGER fail_projection BEFORE INSERT ON settings WHEN NEW.key LIKE 'transfer:%' BEGIN SELECT RAISE(ABORT,'injected projection failure'); END;").unwrap();
    assert!(manager
        .project_transfer_terminal(&terminal, |terminal| project(&conn, terminal))
        .await
        .is_err());
    // Both the linked reference and terminal row are rolled back together.
    assert!(!checkpoint::exists(&conn, &task.id).unwrap());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM settings", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(journal(&fixture).legacy_claims().unwrap()[0].phase == Phase::Terminal);
    conn.execute_batch("DROP TRIGGER fail_projection").unwrap();
    project(&conn, &terminal).unwrap();
    conn.execute(
        "UPDATE settings SET value=json_set(value,'$.toPath','/different') WHERE key=?1",
        [format!("transfer:{}", task.id)],
    )
    .unwrap();
    assert!(manager
        .project_transfer_terminal(&terminal, |terminal| project(&conn, terminal))
        .await
        .is_err());
    assert!(journal(&fixture).legacy_claims().unwrap()[0].phase == Phase::Terminal);
    sftp.close().await.unwrap();
}
