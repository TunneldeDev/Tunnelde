//! Real SFTP replies for the ordinary metadata-channel transfer writer.
use super::*;
use crate::ssh::files::native_save::runtime::MutationObservation;

async fn open(sftp: &SftpSession, observation: &MutationObservation) -> remote_writer::File {
    remote_writer::File::open(
        sftp,
        "target",
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
        observation,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn metadata_writer_owns_open_until_its_original_successful_close() {
    let root = temp_root("observed-metadata-writer");
    let state = Arc::new(State::default());
    let sftp = client(&root, state.clone()).await;
    let observation = MutationObservation::default();
    let mut writer = open(&sftp, &observation).await;
    assert!(!observation.settled());
    writer.write_all(b"owned writer").await.unwrap();
    assert!(!observation.settled());
    writer.finish().await.unwrap();
    assert!(observation.settled());
    assert_eq!(state.closes.load(Ordering::SeqCst), 1);
    assert_eq!(std::fs::read(root.join("target")).unwrap(), b"owned writer");
    sftp.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn metadata_writer_rejected_open_preserves_data_without_retaining_a_handle() {
    let root = temp_root("observed-metadata-rejected");
    std::fs::write(root.join("target"), b"keep existing").unwrap();
    let sftp = client(&root, Arc::new(State::default())).await;
    let observation = MutationObservation::default();
    assert!(remote_writer::File::open(
        &sftp,
        "target",
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
        &observation,
    )
    .await
    .is_err());
    assert!(observation.settled());
    assert_eq!(
        std::fs::read(root.join("target")).unwrap(),
        b"keep existing"
    );
    sftp.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn metadata_writer_dropped_open_keeps_uncertainty_after_a_late_reply() {
    let root = temp_root("observed-metadata-late-open");
    let state = Arc::new(State::default());
    state.hold_open.store(true, Ordering::SeqCst);
    let sftp = client(&root, state.clone()).await;
    let observation = MutationObservation::default();
    {
        let pending = open(&sftp, &observation);
        tokio::pin!(pending);
        tokio::select! {
            _ = &mut pending => panic!("OPEN must wait for its reply"),
            () = state.open_started.notified() => {}
        }
        assert!(!observation.settled());
        // Drop the waiting caller while the original OPEN is still at the peer.
    }
    state.hold_open.store(false, Ordering::SeqCst);
    state.release_open.notify_one();
    sftp.symlink_metadata("target").await.unwrap();
    let another = remote_writer::File::open(&sftp, "target", OpenFlags::WRITE, &observation)
        .await
        .unwrap();
    another.finish().await.unwrap();
    assert!(
        !observation.settled(),
        "later CLOSE cannot settle the lost OPEN"
    );
    sftp.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn metadata_writer_dropped_close_keeps_its_own_open_unsettled() {
    let root = temp_root("observed-metadata-late-close");
    let state = Arc::new(State::default());
    state.delay_close.store(true, Ordering::SeqCst);
    let sftp = client(&root, state.clone()).await;
    let observation = MutationObservation::default();
    let writer = open(&sftp, &observation).await;
    {
        let pending = writer.finish();
        tokio::pin!(pending);
        tokio::select! {
            result = &mut pending => panic!("CLOSE must wait: {result:?}"),
            () = state.close_started.notified() => {}
        }
    }
    state.delay_close.store(false, Ordering::SeqCst);
    state.release_close.notify_one();
    sftp.symlink_metadata("target").await.unwrap();
    assert!(!observation.settled());
    assert_eq!(state.closes.load(Ordering::SeqCst), 1);
    sftp.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn metadata_writer_failed_close_or_buffered_io_cannot_be_settled_by_later_success() {
    for fail_close in [false, true] {
        let root = temp_root(if fail_close {
            "observed-metadata-failed-close"
        } else {
            "observed-metadata-failed-write"
        });
        let state = Arc::new(State::default());
        state.fail_write.store(!fail_close, Ordering::SeqCst);
        state.fail_close.store(fail_close, Ordering::SeqCst);
        let sftp = client(&root, state.clone()).await;
        let observation = MutationObservation::default();
        let mut writer = open(&sftp, &observation).await;
        // File buffers writes; the error may surface in write_all or flush.
        let written = writer.write_all(b"cannot confirm").await;
        let closed = writer.finish().await;
        assert!(written.is_err() || closed.is_err());
        assert_eq!(state.closes.load(Ordering::SeqCst), 1);
        assert!(!observation.settled());
        state.fail_write.store(false, Ordering::SeqCst);
        state.fail_close.store(false, Ordering::SeqCst);
        remote_writer::File::open(&sftp, "target", OpenFlags::WRITE, &observation)
            .await
            .unwrap()
            .finish()
            .await
            .unwrap();
        assert!(!observation.settled());
        sftp.close().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn metadata_writer_drop_is_not_a_close_acknowledgement() {
    let root = temp_root("observed-metadata-drop");
    let sftp = client(&root, Arc::new(State::default())).await;
    let observation = MutationObservation::default();
    drop(open(&sftp, &observation).await);
    sftp.symlink_metadata("target").await.unwrap();
    assert!(!observation.settled());
    sftp.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
