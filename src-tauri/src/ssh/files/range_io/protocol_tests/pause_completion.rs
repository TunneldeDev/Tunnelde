//! An orderly pause must receive original writable-handle completion.
use super::*;

#[tokio::test]
async fn already_cancelled_upload_closes_original_writer_and_allows_epoch_sealing() {
    for write_payload in [false, true] {
        let original = MutationObservation::default();
        let (stream, peer) = stream_with_close(None, Duration::ZERO, CloseReply::default()).await;
        let target = Arc::new(
            DataSession::new_observed(stream, original.clone())
                .await
                .unwrap(),
        );
        let sessions = Sessions {
            source: None,
            target: Some(target),
        };
        let from = Endpoint {
            session: None,
            path: "unused-local-source".into(),
        };
        let to = remote("target");
        let files = Files::open(&sessions, &from, &to).await.unwrap();
        if write_payload {
            sessions
                .target
                .as_ref()
                .unwrap()
                .write(
                    files.target_handle.as_deref().unwrap(),
                    0,
                    b"acknowledged".to_vec(),
                )
                .await
                .unwrap();
        }
        assert!(!original.settled());
        files
            .finish_cancellable(true, &AtomicBool::new(true))
            .await
            .unwrap();
        assert!(original.settled());
        original.seal().unwrap();
        let peer = peer.lock().unwrap();
        assert_eq!(peer.opens, 1);
        assert_eq!(peer.closes, 1);
        assert_eq!(peer.writes.len(), usize::from(write_payload));
    }
}

#[tokio::test]
async fn cancelled_pause_waits_for_its_original_close_reply_not_just_all_writes() {
    let original = MutationObservation::default();
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (stream, peer) = stream_with_close(
        None,
        Duration::ZERO,
        CloseReply {
            gate: Some(gate.clone()),
            status: 0,
        },
    )
    .await;
    let target = Arc::new(
        DataSession::new_observed(stream, original.clone())
            .await
            .unwrap(),
    );
    let sessions = Sessions {
        source: None,
        target: Some(target),
    };
    let from = Endpoint {
        session: None,
        path: "unused-local-source".into(),
    };
    let to = remote("target");
    let files = Files::open(&sessions, &from, &to).await.unwrap();
    let cancel = AtomicBool::new(true);
    let finish = files.finish_cancellable(true, &cancel);
    tokio::pin!(finish);
    tokio::select! {
        result = &mut finish => panic!("pause skipped original CLOSE: {result:?}"),
        () = wait_for(|| peer.lock().unwrap().closes == 1) => {}
    }
    assert!(!original.settled());
    assert!(original.seal().is_err());
    assert!(tokio::time::timeout(Duration::from_millis(30), &mut finish)
        .await
        .is_err());
    gate.add_permits(1);
    finish.await.unwrap();
    assert!(original.settled());
    original.seal().unwrap();
}
