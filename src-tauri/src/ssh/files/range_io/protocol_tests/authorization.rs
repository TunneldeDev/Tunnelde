//! Exercise live revocation against real SFTP packets and handle completion.
use super::*;

#[tokio::test]
async fn queued_data_admission_preserves_typed_cancel_and_revocation_without_wire_io() {
    use crate::ssh::files::Outcome;
    for reason in [CANCELLED, "pluginSecurity.changed"] {
        for kind in ["write", "mkdir"] {
            let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let current = calls.clone();
            let original = MutationObservation::default();
            let guarded = original.guarded(move || {
                if current.fetch_add(1, Ordering::SeqCst) == 0 {
                    Ok(()) // Initially admitted before entering the worker queue.
                } else if reason == CANCELLED {
                    Err(AppError::Ssh(reason.into()))
                } else {
                    Err(AppError::validation(reason))
                }
            });
            let (stream, peer) =
                stream_with_close(None, Duration::ZERO, CloseReply::default()).await;
            let session = DataSession::new_observed(stream, guarded).await.unwrap();
            let result = if kind == "write" {
                session.write("unused", 0, vec![7]).await
            } else {
                session
                    .create_private_directory("/never-created")
                    .await
                    .map(|_| ())
            };
            assert_eq!(result.as_ref().unwrap_err().to_string(), reason);
            assert_eq!(calls.load(Ordering::SeqCst), 2);
            assert!(
                original.settled(),
                "unsent denial acquired an unknown request"
            );
            assert!(peer.lock().unwrap().writes.is_empty());
            match Outcome::from_result(result, 42, &AtomicBool::new(true)) {
                Outcome::Cancelled(42) if reason == CANCELLED => {}
                Outcome::Failed(42, AppError::Validation(error)) if error == reason => {}
                _ => panic!("queued {kind} lost its typed admission result: {reason}"),
            }
        }
    }
}

#[tokio::test]
async fn actual_plugin_policy_revocation_restriction_and_new_generation_stop_wire_writes() {
    use crate::plugins::security::PluginSecurity;
    for action in ["revoke", "restrict", "restart"] {
        let db = crate::db::Database::in_memory().unwrap();
        let security = Arc::new(PluginSecurity::default());
        let fingerprint = "b".repeat(64);
        let permissions = vec!["sftp.write".to_owned()];
        security
            .set_permissions(
                &db,
                "writer",
                fingerprint.clone(),
                &permissions,
                Some(permissions.clone()),
            )
            .unwrap();
        let lease = security.lease("writer", fingerprint, permissions).unwrap();
        let policy = security.clone();
        let original = MutationObservation::default();
        let (stream, peer) = stream_with_close(None, Duration::ZERO, CloseReply::default()).await;
        let session = DataSession::new_observed(
            stream,
            original.guarded(move || {
                policy
                    .authorize(
                        &lease.id,
                        &lease.fingerprint,
                        &lease.permissions,
                        Some("sftp.write"),
                        Some(lease.generation),
                    )
                    .map(|_| ())
            }),
        )
        .await
        .unwrap();
        let handle = session.open("/stage", true).await.unwrap();
        match action {
            "revoke" => security
                .set_permissions(&db, "writer", String::new(), &[], None)
                .unwrap(),
            "restrict" => security.set_restricted(&db, true, false).unwrap(),
            "restart" => security.invalidate_runtime("writer"),
            _ => unreachable!(),
        }
        assert!(
            session.write(&handle, 0, b"denied".to_vec()).await.is_err(),
            "{action}"
        );
        assert!(peer.lock().unwrap().writes.is_empty(), "{action}");
        session.close(&handle).await.unwrap();
        assert!(original.settled(), "{action}");
    }
}

#[tokio::test]
async fn revocation_while_download_waits_for_read_prevents_local_write() {
    let path =
        std::env::temp_dir().join(format!("tunnelde-denied-download-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&path, b"unchanged").await.unwrap();
    let (source, peer) = server(None, Duration::ZERO).await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    {
        let mut peer = peer.lock().unwrap();
        peer.data = b"overwrite".to_vec();
        peer.read_gates.insert(0, gate.clone());
    }
    let allowed = Arc::new(AtomicBool::new(true));
    let current = allowed.clone();
    let observation = MutationObservation::default().guarded(move || {
        current
            .load(Ordering::Acquire)
            .then_some(())
            .ok_or_else(|| AppError::validation("pluginSecurity.changed"))
    });
    let sessions = Sessions {
        source: Some(source),
        target: None,
    };
    let from = remote("source");
    let to = Endpoint {
        session: None,
        path: display_path(&path),
    };
    let files = Files::open(&sessions, &from, &to)
        .await
        .unwrap()
        .with_observation(observation);
    let transferred = AtomicU64::new(0);
    let stop = AtomicBool::new(false);
    let (result, ()) = tokio::join!(files.segment(0..9, 1, &stop, &transferred), async {
        wait_for(|| !peer.lock().unwrap().reads.is_empty()).await;
        allowed.store(false, Ordering::Release);
        gate.add_permits(1);
    });
    assert_eq!(result.unwrap_err().to_string(), "pluginSecurity.changed");
    files.finish(true).await.unwrap();
    assert_eq!(transferred.load(Ordering::Acquire), 0);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"unchanged");
    tokio::fs::remove_file(path).await.unwrap();
}

#[tokio::test]
async fn revoked_data_channel_sends_no_new_mutations_but_closes_its_original_handle() {
    let (stream, peer) = stream_with_close(None, Duration::ZERO, CloseReply::default()).await;
    let allowed = Arc::new(AtomicBool::new(true));
    let current = allowed.clone();
    let original = MutationObservation::default();
    let guarded = original.guarded(move || {
        current
            .load(Ordering::Acquire)
            .then_some(())
            .ok_or_else(|| AppError::validation("pluginSecurity.changed"))
    });
    let session = DataSession::new_observed(stream, guarded).await.unwrap();
    let handle = session.open("/staging", true).await.unwrap();
    session.write(&handle, 0, b"before".to_vec()).await.unwrap();
    allowed.store(false, Ordering::Release);
    assert!(session.write(&handle, 6, b"after".to_vec()).await.is_err());
    assert!(session.open("/other", true).await.is_err());
    assert!(session.create_private_directory("/other").await.is_err());
    assert!(
        !original.settled(),
        "the original writable OPEN is still owned"
    );
    session.close(&handle).await.unwrap();
    assert!(original.settled());
    original.seal().unwrap();
    let peer = peer.lock().unwrap();
    assert_eq!(peer.opens, 1);
    assert_eq!(peer.writes.len(), 1);
    assert_eq!(peer.data, b"before");
    assert_eq!(peer.closes, 1);
}

#[tokio::test]
async fn revocation_during_original_write_does_not_discard_its_late_response() {
    let (stream, peer) = stream_with_close(None, Duration::ZERO, CloseReply::default()).await;
    let allowed = Arc::new(AtomicBool::new(true));
    let current = allowed.clone();
    let original = MutationObservation::default();
    let session = Arc::new(
        DataSession::new_observed(
            stream,
            original.guarded(move || {
                current
                    .load(Ordering::Acquire)
                    .then_some(())
                    .ok_or_else(|| AppError::validation("pluginSecurity.changed"))
            }),
        )
        .await
        .unwrap(),
    );
    let handle = session.open("/staging", true).await.unwrap();
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    peer.lock().unwrap().write_gate = Some(gate.clone());
    let writer = session.clone();
    let writing_handle = handle.clone();
    let writing =
        tokio::spawn(async move { writer.write(&writing_handle, 0, b"original".to_vec()).await });
    wait_for(|| !peer.lock().unwrap().writes.is_empty()).await;
    allowed.store(false, Ordering::Release);
    assert!(!original.settled());
    assert!(session.write(&handle, 8, b"later".to_vec()).await.is_err());
    gate.add_permits(1);
    writing.await.unwrap().unwrap();
    session.close(&handle).await.unwrap();
    assert!(original.settled());
    assert_eq!(peer.lock().unwrap().writes.len(), 1);
}
