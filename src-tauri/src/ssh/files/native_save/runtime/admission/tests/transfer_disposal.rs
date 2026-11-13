//! Original private task, offline copy source and retired plugin remain distinct.
use super::mutation::{journal, setup};
use super::transfer_worker::{database, task};
use super::*;
use crate::plugins::security::PluginSecurity;
use crate::ssh::files::native_save::{
    journal::admission::{TaskEndpoint, TransferOutcome},
    runtime::MutationTarget,
};
use crate::ssh::files::{
    durable::DurableTransfer,
    transfer_ownership::{self, checkpoint, terminal::project},
    TransferRegistry,
};

struct DisposalServer(Arc<AtomicBool>);
impl russh_sftp::server::Handler for DisposalServer {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        let canonical = match path.as_str() {
            "/requested" | "/workspace/actual" => "/workspace/actual",
            "/generated" | "/workspace/.stage" => "/workspace/.stage",
            _ => return Err(StatusCode::NoSuchFile),
        };
        Ok(Name {
            id,
            files: vec![File::new(canonical, FileAttributes::empty())],
        })
    }
    async fn remove(
        &mut self,
        id: u32,
        path: String,
    ) -> Result<russh_sftp::protocol::Status, StatusCode> {
        if path != "/generated" || self.0.swap(true, Ordering::SeqCst) {
            return Err(StatusCode::PermissionDenied);
        }
        Ok(russh_sftp::protocol::Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        })
    }
}

#[tokio::test]
async fn original_plugin_copy_disposal_needs_only_destination_and_preserves_private_attribution() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let removed = Arc::new(AtomicBool::new(false));
    let (client, stream) = tokio::io::duplex(8192);
    russh_sftp::server::run(stream, DisposalServer(removed.clone())).await;
    let sftp = SftpSession::new(client).await.unwrap();
    let mut task = task(&destination);
    task.plugin_id = Some("original-plugin".into());
    task.source = TaskEndpoint {
        path: "/offline-source".into(),
        remote: Some(SessionIdentity {
            host_id: "source-host".into(),
            address: "user@offline:22".into(),
            server_key: destination.server_key.clone(),
        }),
    };
    let paths = vec![task.destination.path.clone()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &paths,
    }];
    let registry = TransferRegistry::default();
    registry
        .register(&task.id, Arc::new(AtomicBool::new(false)), None)
        .unwrap();
    let ownership = registry.ownership(&task.id).unwrap();
    let conn = database();
    transfer_ownership::admit(
        &manager,
        &ownership,
        task.clone(),
        &targets,
        registry.observation(&task.id).unwrap(),
        (false, |reference| {
            checkpoint::link(&conn, &task.id, reference)
        }),
        || Ok(()),
    )
    .await
    .unwrap();
    ownership
        .lock()
        .await
        .as_mut()
        .unwrap()
        .extend_paths(&destination, &sftp, &["/generated".into()])
        .await
        .unwrap();
    registry.park_ownership(&task.id).await.unwrap();
    registry.release(&task.id);

    let db = crate::db::Database::in_memory().unwrap();
    let security = PluginSecurity::default();
    let fingerprint = "b".repeat(64);
    let permissions = vec!["sftp.write".to_owned()];
    security
        .set_permissions(
            &db,
            "original-plugin",
            fingerprint.clone(),
            &permissions,
            Some(permissions.clone()),
        )
        .unwrap();
    let lease = security
        .lease("original-plugin", fingerprint, permissions)
        .unwrap();
    security.invalidate_runtime("original-plugin");
    assert!(security
        .authorize(
            &lease.id,
            &lease.fingerprint,
            &lease.permissions,
            None,
            Some(lease.generation)
        )
        .is_err());
    let row:DurableTransfer = serde_json::from_value(serde_json::json!({
        "id":task.id,"pluginId":"original-plugin","direction":"transfer","name":"file",
        "fromSession":"offline-session","fromHostId":"source-host","fromAddress":"user@offline:22","fromPath":"/offline-source",
        "toSession":"new-target-session","toHostId":destination.host_id,"toAddress":destination.address,"toPath":"/requested",
        "removeSource":false,"overwrite":false,"transferred":0,"total":0,"status":"cleanupPending","error":null,"updatedAt":1
    })).unwrap();
    conn.pragma_update(None, "synchronous", "FULL").unwrap();
    conn.execute(
        "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,1)",
        rusqlite::params![
            format!("transfer:{}", task.id),
            serde_json::to_string(&row).unwrap()
        ],
    )
    .unwrap();
    conn.pragma_update(None, "synchronous", "NORMAL").unwrap();
    registry
        .register(&task.id, Arc::new(AtomicBool::new(false)), None)
        .unwrap();
    let fresh = registry.begin_cleanup(&task.id).unwrap();
    registry
        .install_cleanup(&row, task.destination.clone())
        .unwrap();
    let original = manager
        .transfer_task_intent(&task.id)
        .await
        .unwrap()
        .unwrap();
    assert!(original == task);
    transfer_ownership::admit(
        &manager,
        &registry.ownership(&task.id).unwrap(),
        original,
        &targets,
        fresh.clone(),
        (true, |reference| {
            checkpoint::link(&conn, &task.id, reference)
        }),
        || Ok(()),
    )
    .await
    .unwrap();
    let cleanup = registry.ownership(&task.id).unwrap();
    cleanup
        .lock()
        .await
        .as_ref()
        .unwrap()
        .validate_paths(&destination, &sftp, &["/generated".into()])
        .await
        .unwrap();
    fresh.request(sftp.remove_file("/generated")).await.unwrap();
    assert!(removed.load(Ordering::SeqCst));
    let terminal = registry
        .ownership(&task.id)
        .unwrap()
        .lock()
        .await
        .as_mut()
        .unwrap()
        .complete(TransferOutcome::Disposed)
        .await
        .unwrap();
    manager
        .project_transfer_terminal(&terminal, |terminal| project(&conn, terminal))
        .await
        .unwrap();
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    let value: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [format!("transfer:{}", task.id)],
            |row| row.get(0),
        )
        .unwrap();
    let restored: DurableTransfer = serde_json::from_str(&value).unwrap();
    assert_eq!(restored.status, "cancelled");
    assert_eq!(restored.plugin_id.as_deref(), Some("original-plugin"));
    assert_eq!(restored.from_host_id.as_deref(), Some("source-host"));
    assert!(security
        .authorize(
            &lease.id,
            &lease.fingerprint,
            &lease.permissions,
            None,
            Some(lease.generation)
        )
        .is_err());
    registry.release(&task.id);
    sftp.close().await.unwrap();
}
