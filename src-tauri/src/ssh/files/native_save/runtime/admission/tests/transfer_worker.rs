//! Exercise actual task-registry ownership, private journal and synced app link.
use super::mutation::{journal, setup};
use super::*;
use crate::ssh::files::native_save::{
    journal::admission::{Phase, TaskEndpoint, TransferOutcome, TransferTask},
    runtime::mutation::MutationTarget,
};
use crate::ssh::files::{
    transfer_ownership::{self, checkpoint},
    TransferRegistry,
};

pub(super) fn task(destination: &SessionIdentity) -> TransferTask {
    TransferTask {
        id: uuid::Uuid::new_v4().to_string(),
        source: TaskEndpoint {
            path: "C:/input.json".into(),
            remote: None,
        },
        destination: TaskEndpoint {
            path: "/requested".into(),
            remote: Some(destination.clone()),
        },
        remove_source: false,
        overwrite: false,
        plugin_id: None,
    }
}

pub(super) fn database() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA synchronous=NORMAL;CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);CREATE TRIGGER require_synced_link BEFORE INSERT ON settings WHEN (SELECT synchronous FROM pragma_synchronous)<2 BEGIN SELECT RAISE(ABORT,'link must be synced');END;").unwrap();
    conn
}

struct DelayedMkdir {
    arrived: Arc<Semaphore>,
    release: Arc<Semaphore>,
    hold: bool,
}
impl russh_sftp::server::Handler for DelayedMkdir {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        if !matches!(path.as_str(), "/requested" | "/workspace/actual") {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(Name {
            id,
            files: vec![File::new("/workspace/actual", FileAttributes::empty())],
        })
    }
    async fn mkdir(
        &mut self,
        _id: u32,
        _path: String,
        _attrs: FileAttributes,
    ) -> Result<russh_sftp::protocol::Status, StatusCode> {
        if self.hold {
            self.hold = false;
            self.arrived.add_permits(1);
            self.release.acquire().await.unwrap().forget();
        }
        Err(StatusCode::PermissionDenied)
    }
}

#[tokio::test]
async fn actual_task_registry_retains_single_original_permit_through_late_reply_and_cleanup_epoch()
{
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let arrived = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let (client, peer) = tokio::io::duplex(8192);
    russh_sftp::server::run(
        peer,
        DelayedMkdir {
            arrived: arrived.clone(),
            release: release.clone(),
            hold: true,
        },
    )
    .await;
    let sftp = Arc::new(SftpSession::new(client).await.unwrap());
    let paths = vec!["/requested".into()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &paths,
    }];
    let task = task(&destination);
    let registry = TransferRegistry::default();
    registry
        .register(&task.id, Arc::new(AtomicBool::new(false)), None)
        .unwrap();
    let original = registry.observation(&task.id).unwrap();
    let ownership = registry.ownership(&task.id).unwrap();
    let conn = database();
    transfer_ownership::admit(
        &manager,
        &ownership,
        task.clone(),
        &targets,
        original.clone(),
        (false, |reference| {
            checkpoint::link(&conn, &task.id, reference)
        }),
        || Ok(()),
    )
    .await
    .unwrap();
    assert!(checkpoint::exists(&conn, &task.id).unwrap());
    let reference = manager.transfer_task_reference(&task).await.err().unwrap();
    assert_eq!(reference.to_string(), "editor.remoteOutcomeUnknown");
    assert_eq!(
        conn.pragma_query_value(None, "synchronous", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    {
        let remote = sftp.clone();
        let wait = original.retained(async move { remote.create_dir("/requested").await });
        tokio::pin!(wait);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::select! {
                result=&mut wait => panic!("server is holding original reply: {result:?}"),
                permit=arrived.acquire()=>permit.unwrap().forget(),
            }
        })
        .await
        .unwrap();
    }
    assert!(ownership
        .lock()
        .await
        .as_mut()
        .unwrap()
        .complete(TransferOutcome::Disposed)
        .await
        .is_err());
    assert!(journal(&fixture).legacy_claims().unwrap()[0].phase == Phase::Dispatched);
    assert!(registry.park_ownership(&task.id).await.is_err());
    registry.release(&task.id);
    assert!(registry
        .register(&task.id, Arc::new(AtomicBool::new(false)), None)
        .is_err());
    release.add_permits(1);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !original.settled() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    registry
        .register(&task.id, Arc::new(AtomicBool::new(false)), None)
        .unwrap();
    assert!(original.closed());
    let fresh = registry.begin_cleanup(&task.id).unwrap();
    let retained = registry.ownership(&task.id).unwrap();
    assert!(Arc::ptr_eq(&ownership, &retained));
    transfer_ownership::admit(
        &manager,
        &retained,
        task.clone(),
        &targets,
        fresh.clone(),
        (true, |reference| {
            checkpoint::link(&conn, &task.id, reference)
        }),
        || Ok(()),
    )
    .await
    .unwrap();
    assert!(fresh.request(sftp.create_dir("/requested")).await.is_err());
    assert!(fresh.settled());
    registry.park_ownership(&task.id).await.unwrap();
    assert!(fresh.closed());
    let claims = journal(&fixture).legacy_claims().unwrap();
    assert_eq!(claims.len(), 1);
    assert!(claims[0].phase == Phase::Recoverable);
    assert!(claims[0].transfer_task.as_ref() == Some(&task));
    registry.release(&task.id);
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn failed_app_link_never_dispatches_and_missing_private_claim_never_recreates_one() {
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
    let paths = vec!["/requested".into()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &paths,
    }];
    let task = task(&destination);
    let ownership = transfer_ownership::Shared::default();
    let result = transfer_ownership::admit(
        &manager,
        &ownership,
        task.clone(),
        &targets,
        MutationObservation::default(),
        (false, |_| {
            Err(crate::error::AppError::validation("injected disk failure"))
        }),
        || Ok(()),
    )
    .await;
    assert!(result.is_err());
    let claims = journal(&fixture).legacy_claims().unwrap();
    assert!(claims[0].phase == Phase::Prepared);
    assert!(ownership.lock().await.is_none());
    let reference = manager
        .transfer_task_reference(&task)
        .await
        .unwrap()
        .unwrap();
    let conn = database();
    let unrelated = uuid::Uuid::new_v4().to_string();
    assert!(checkpoint::link(&conn, &unrelated, &reference).is_err());
    assert!(!checkpoint::exists(&conn, &unrelated).unwrap());
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert!(checkpoint::link(&conn, &task.id, &reference).is_err());
    conn.execute_batch("ROLLBACK").unwrap();
    assert!(!checkpoint::exists(&conn, &task.id).unwrap());
    let unsent = manager
        .resume_transfer_mutation(&reference, &targets)
        .await
        .unwrap();
    unsent.retire().await.unwrap();
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    let result = transfer_ownership::admit(
        &manager,
        &ownership,
        task,
        &targets,
        MutationObservation::default(),
        (true, |_| Ok(())),
        || Ok(()),
    )
    .await;
    assert!(result.is_err());
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn revocation_after_durable_dispatch_parks_without_polling_a_mutation() {
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
    let paths = vec!["/requested".into()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &paths,
    }];
    let task = task(&destination);
    let ownership = transfer_ownership::Shared::default();
    let checks = std::cell::Cell::new(0);
    let result = transfer_ownership::admit(
        &manager,
        &ownership,
        task.clone(),
        &targets,
        MutationObservation::default(),
        (false, |_| Ok(())),
        || {
            let checked = checks.get();
            checks.set(checked + 1);
            if checked == 0 {
                Ok(())
            } else {
                Err(crate::error::AppError::validation("revoked"))
            }
        },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(checks.get(), 2);
    let claims = journal(&fixture).legacy_claims().unwrap();
    assert!(claims[0].phase == Phase::Recoverable);
    assert!(manager
        .transfer_task_reference(&task)
        .await
        .unwrap()
        .is_some());
    assert!(ownership.lock().await.is_none());
    sftp.close().await.unwrap();
}
