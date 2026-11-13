//! The queue's wire writer rechecks authority without discarding original CLOSE.
use super::*;

#[tokio::test]
async fn revoked_compressed_writer_rejects_new_packets_and_completes_original_close() {
    let (client, mut peer) = duplex(1024 * 1024);
    peer.write_all(MAGIC).await.unwrap();
    let mut peer = BufReader::new(peer);
    let allowed = Arc::new(AtomicBool::new(true));
    let current = allowed.clone();
    let original = MutationObservation::default();
    let session = Arc::new(
        Session::new_observed(
            client,
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
    let captured = session.clone();
    let opening = tokio::spawn(async move { captured.open("/stage/file", true).await });
    let request = receive(&mut peer).await;
    reply(
        &mut peer,
        &request["id"],
        json!({"size":0,"handle":"original"}),
    )
    .await;
    let handle = opening.await.unwrap().unwrap();
    allowed.store(false, Ordering::Release);
    assert!(session.open("/must-not-open", true).await.is_err());
    assert!(session.write(&handle, 0, b"denied".to_vec()).await.is_err());
    assert!(session
        .create_private_directory("/must-not-create")
        .await
        .is_err());
    assert!(session
        .write_archive(
            vec![super::super::super::super::archive::Entry {
                path: "/stage/file".into(),
                length: 6,
            }],
            vec![b"denied".to_vec()],
            false
        )
        .await
        .is_err());
    assert!(!original.settled());
    let captured = session.clone();
    let closing = tokio::spawn(async move { captured.close(&handle).await });
    // Any incorrectly admitted mutation would appear here before CLOSE.
    let request = receive(&mut peer).await;
    assert_eq!(request["op"], "close");
    reply(&mut peer, &request["id"], json!({"size":0})).await;
    closing.await.unwrap().unwrap();
    settled(&original).await;
    original.seal().unwrap();
}
