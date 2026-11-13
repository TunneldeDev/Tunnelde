//! Directory mutation receipts follow the original request, not the caller.
use super::*;
use crate::ssh::files::native_save::runtime::MutationObservation;

fn target() -> Endpoint {
    Endpoint {
        session: Some("test".into()),
        path: "target".into(),
    }
}

#[tokio::test]
async fn observed_directory_unsent_cancel_and_metadata_failures_do_not_retain_a_mutation() {
    let root = temp_root("observed-directory-unsent");
    let state = Arc::new(State::default());
    let sftp = client(&root, state.clone()).await;
    let observation = MutationObservation::default();
    let cancel = AtomicBool::new(true);
    assert!(
        make_dir(&target(), Some(&sftp), Some(&cancel), observation.clone())
            .await
            .is_err()
    );
    assert!(observation.settled());
    state.fail_metadata.store(true, Ordering::SeqCst);
    assert!(make_dir(&target(), Some(&sftp), None, observation.clone())
        .await
        .is_err());
    assert!(observation.settled());
    assert_eq!(state.directories_created.load(Ordering::SeqCst), 0);
    sftp.close().await.unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[tokio::test]
async fn observed_directory_waits_for_mkdir_acknowledgement_after_cancellation() {
    let root = temp_root("observed-directory-cancel");
    let state = Arc::new(State::default());
    state.hold_mkdir.store(true, Ordering::SeqCst);
    let sftp = client(&root, state.clone()).await;
    let observation = MutationObservation::default();
    let cancel = AtomicBool::new(false);
    let endpoint = target();
    let operation = make_dir(&endpoint, Some(&sftp), Some(&cancel), observation.clone());
    tokio::pin!(operation);
    tokio::select! {
        result = &mut operation => panic!("MKDIR must wait: {result:?}"),
        () = state.mkdir_started.notified() => {}
    }
    assert!(!observation.settled());
    cancel.store(true, Ordering::SeqCst);
    state.release_mkdir.notify_one();
    assert_eq!(operation.await.unwrap_err().to_string(), CANCELLED);
    assert!(observation.settled());
    assert_eq!(state.directories_created.load(Ordering::SeqCst), 1);
    sftp.close().await.unwrap();
    std::fs::remove_dir(root.join("target")).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[tokio::test]
async fn observed_directory_dropped_request_is_not_settled_by_a_later_stat() {
    let root = temp_root("observed-directory-drop");
    let state = Arc::new(State::default());
    state.hold_mkdir.store(true, Ordering::SeqCst);
    let sftp = client(&root, state.clone()).await;
    let observation = MutationObservation::default();
    let endpoint = target();
    {
        let operation = make_dir(&endpoint, Some(&sftp), None, observation.clone());
        tokio::pin!(operation);
        tokio::select! {
            result = &mut operation => panic!("MKDIR must wait: {result:?}"),
            () = state.mkdir_started.notified() => {}
        }
    }
    state.release_mkdir.notify_one();
    sftp.symlink_metadata("target").await.unwrap();
    assert!(!observation.settled());
    // A separate already-existing-directory success has no mutation receipt.
    make_dir(&endpoint, Some(&sftp), None, observation.clone())
        .await
        .unwrap();
    assert!(!observation.settled());
    sftp.close().await.unwrap();
    std::fs::remove_dir(root.join("target")).unwrap();
    std::fs::remove_dir(root).unwrap();
}
