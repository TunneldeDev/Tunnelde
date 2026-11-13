//! Actual unlink replies must outlive the task result and gate subsequent cleanup.
use super::*;
use crate::ssh::files::native_save::runtime::MutationObservation;

fn endpoint() -> Endpoint {
    Endpoint {
        session: Some("test".into()),
        path: "target".into(),
    }
}

#[tokio::test]
async fn original_unlink_reply_allows_cleanup_only_after_the_actual_response() {
    let root = temp_root("observed-unlink-late");
    std::fs::write(root.join("target"), b"staging").unwrap();
    let state = Arc::new(State::default());
    state.hold_remove.store(true, Ordering::SeqCst);
    let sftp = client(&root, state.clone()).await;
    let registry = TransferRegistry::default();
    registry
        .register("job", Arc::new(AtomicBool::new(false)), None)
        .unwrap();
    let observation = registry.observation("job").unwrap();
    let target = endpoint();
    let work = remove_transfer_file(&target, Some(&sftp), &observation);
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => panic!("unlink must wait for the original response: {result:?}"),
        () = state.remove_started.notified() => {}
    }
    registry.release("job");
    assert!(registry.reserve_cleanup("job").is_err());
    state.release_remove.notify_one();
    work.await.unwrap();
    let reservation = registry.reserve_cleanup("job").unwrap();
    assert!(observation.closed());
    assert!(!root.join("target").exists());
    drop(reservation);
    sftp.close().await.unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[tokio::test]
async fn missing_file_cannot_settle_a_retained_unlink_before_its_own_reply() {
    let root = temp_root("observed-unlink-drop");
    std::fs::write(root.join("target"), b"staging").unwrap();
    let state = Arc::new(State::default());
    state.hold_remove_reply.store(true, Ordering::SeqCst);
    let sftp = client(&root, state.clone()).await;
    let observer = client(&root, state.clone()).await;
    let observation = MutationObservation::default();
    let target = endpoint();
    {
        let work = remove_transfer_file(&target, Some(&sftp), &observation);
        tokio::pin!(work);
        tokio::select! {
            result = &mut work => panic!("unlink must wait: {result:?}"),
            () = state.remove_applied.notified() => {}
        }
    }
    metadata::close(sftp).await;
    assert!(file_length(&target, Some(&observer))
        .await
        .unwrap()
        .is_none());
    assert!(!observation.settled());
    assert!(observation.seal().is_err());
    state.release_remove_reply.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !observation.settled() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    observation.seal().unwrap();
    observer.close().await.unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[tokio::test]
async fn sealed_task_cannot_remove_a_source_or_artifact_on_an_old_channel() {
    let root = temp_root("observed-unlink-sealed");
    std::fs::write(root.join("target"), b"preserve").unwrap();
    let state = Arc::new(State::default());
    let sftp = client(&root, state.clone()).await;
    let observation = MutationObservation::default();
    observation.seal().unwrap();
    assert!(remove_transfer_file(&endpoint(), Some(&sftp), &observation)
        .await
        .is_err());
    assert!(remove_endpoint(&endpoint(), Some(&sftp), &observation)
        .await
        .is_err());
    assert_eq!(state.removals.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read(root.join("target")).unwrap(), b"preserve");
    sftp.close().await.unwrap();
    std::fs::remove_file(root.join("target")).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[tokio::test]
async fn original_source_unlink_and_terminal_rejection_settle_their_own_requests() {
    let root = temp_root("observed-source-unlink");
    std::fs::write(root.join("target"), b"source").unwrap();
    let state = Arc::new(State::default());
    let sftp = client(&root, state.clone()).await;
    let observation = MutationObservation::default();
    remove_endpoint(&endpoint(), Some(&sftp), &observation)
        .await
        .unwrap();
    assert!(observation.settled());
    assert!(remove_transfer_file(&endpoint(), Some(&sftp), &observation)
        .await
        .is_err());
    assert!(observation.settled());
    assert_eq!(state.removals.load(Ordering::SeqCst), 2);
    observation.seal().unwrap();
    sftp.close().await.unwrap();
    std::fs::remove_dir(root).unwrap();
}
