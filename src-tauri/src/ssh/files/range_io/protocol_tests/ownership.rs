//! Actual data-channel requests, not manufactured presentation errors.
use super::*;

async fn observed(
    close: CloseReply,
) -> (Arc<DataSession>, Arc<Mutex<Observed>>, MutationObservation) {
    let (client, state) = stream_with_close(None, Duration::ZERO, close).await;
    let observation = MutationObservation::default();
    let channel = Arc::new(
        DataSession::new_observed(client, observation.clone())
            .await
            .unwrap(),
    );
    (channel, state, observation)
}

#[tokio::test]
async fn sealed_epoch_rejects_raw_mutation_before_open_or_write_reaches_the_peer() {
    let (channel, state, observation) = observed(CloseReply::default()).await;
    observation.seal().unwrap();
    assert!(channel.open("/must-not-open", true).await.is_err());
    assert!(channel.write("old-handle", 0, vec![7; 19]).await.is_err());
    assert_eq!(state.lock().unwrap().opens, 0);
    assert!(state.lock().unwrap().writes.is_empty());
    let handle = channel.open("/readonly", false).await.unwrap();
    channel.close(&handle).await.unwrap();
    assert!(observation.settled());
}

#[tokio::test]
async fn writable_open_is_owned_until_its_original_successful_close() {
    for rejected_write in [false, true] {
        let (channel, state, observation) = observed(CloseReply::default()).await;
        state.lock().unwrap().write_status = if rejected_write { 3 } else { 0 };
        assert!(observation.settled());
        let handle = channel.open("/target", true).await.unwrap();
        assert!(!observation.settled());
        assert_eq!(
            channel.write(&handle, 0, vec![1; 17]).await.is_err(),
            rejected_write
        );
        assert!(
            !observation.settled(),
            "write completion cannot close its handle"
        );
        channel.close(&handle).await.unwrap();
        assert!(observation.settled());
    }
}

#[tokio::test]
async fn rejected_or_dropped_close_never_releases_a_writable_handle() {
    for status in [0, 4] {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let (channel, state, observation) = observed(CloseReply {
            status,
            gate: (status == 0).then(|| gate.clone()),
        })
        .await;
        let handle = channel.open("/target", true).await.unwrap();
        if status == 0 {
            let captured = channel.clone();
            let task = tokio::spawn(async move { captured.close(&handle).await });
            wait_for(|| state.lock().unwrap().closes == 1).await;
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            gate.add_permits(1);
        } else {
            assert!(channel.close(&handle).await.is_err());
        }
        assert!(!observation.settled());
        drop(channel);
        assert!(
            !observation.settled(),
            "dropping a channel is not a close reply"
        );
    }
}

#[tokio::test]
async fn dropped_raw_write_is_not_acknowledged_by_a_later_close_or_peer_reply() {
    let (channel, state, observation) = observed(CloseReply::default()).await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    state.lock().unwrap().write_gate = Some(gate.clone());
    let handle = channel.open("/target", true).await.unwrap();
    let writer = channel.clone();
    let target = handle.clone();
    let task = tokio::spawn(async move { writer.write(&target, 0, vec![7; 19]).await });
    wait_for(|| !state.lock().unwrap().writes.is_empty()).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    channel.close(&handle).await.unwrap();
    assert!(!observation.settled());
    gate.add_permits(1);
    wait_for(|| state.lock().unwrap().pending == 0).await;
    // Unlike the compressed worker, the raw library no longer delivers the
    // dropped request's response to us. Do not infer it from a later CLOSE.
    assert!(!observation.settled());
}

#[tokio::test]
async fn readonly_failures_and_unsent_write_opens_do_not_acquire_mutation_ownership() {
    let (channel, state, observation) = observed(CloseReply {
        status: 4,
        gate: None,
    })
    .await;
    let handle = channel.open("/source", false).await.unwrap();
    assert!(channel.close(&handle).await.is_err());
    assert!(observation.settled());
    state.lock().unwrap().reject_open = true;
    assert!(channel.open("/denied", true).await.is_err());
    assert!(observation.settled());
    let unsent = channel.open("/never-polled", true);
    drop(unsent);
    assert!(observation.settled());
}

#[tokio::test]
async fn only_terminal_mkdir_statuses_acknowledge_the_original_request() {
    for status in 0..=8 {
        let (channel, state, observation) = observed(CloseReply::default()).await;
        state.lock().unwrap().mkdir_status = status;
        let reply = channel.create_private_directory("/stage").await;
        let terminal = matches!(status, 0 | 2 | 3 | 4 | 8);
        assert_eq!(observation.settled(), terminal, "status {status}");
        assert_eq!(
            reply.is_ok(),
            terminal,
            "pseudo status {status} was treated as rejection"
        );
    }
}

#[tokio::test]
async fn copy_data_lost_reply_keeps_ownership_after_later_successful_writes() {
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (client, state) = stream_with_copy(
        None,
        Duration::ZERO,
        CloseReply::default(),
        Some(CopyReply {
            advertised: Some("1".into()),
            gate: Some(gate.clone()),
            ..CopyReply::default()
        }),
    )
    .await;
    state.lock().unwrap().data = vec![9; 32];
    let observation = MutationObservation::default();
    let channel = Arc::new(
        DataSession::new_observed(client, observation.clone())
            .await
            .unwrap(),
    );
    let captured = channel.clone();
    let task = tokio::spawn(async move { captured.copy_range("/source", "/target", 0, 16).await });
    wait_for(|| !state.lock().unwrap().copies.is_empty()).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    gate.add_permits(1);
    wait_for(|| state.lock().unwrap().pending == 0).await;
    channel.write("/target", 16, vec![4; 16]).await.unwrap();
    assert!(!observation.settled());
}

#[tokio::test]
async fn copy_data_decodes_the_original_status_before_acknowledging_it() {
    for status in 0..=8 {
        let (client, state) = stream_with_copy(
            None,
            Duration::ZERO,
            CloseReply::default(),
            Some(CopyReply {
                advertised: Some("1".into()),
                status,
                ..CopyReply::default()
            }),
        )
        .await;
        state.lock().unwrap().data = vec![7; 32];
        let observation = MutationObservation::default();
        let channel = DataSession::new_observed(client, observation.clone())
            .await
            .unwrap();
        let result = channel.copy_range("/source", "/target", 0, 16).await;
        assert_eq!(result.is_ok(), status == 0);
        assert_eq!(
            observation.settled(),
            matches!(status, 0 | 2 | 3 | 4 | 8),
            "status {status}"
        );
    }
}

#[tokio::test]
async fn dropped_raw_write_open_retains_ownership_after_its_handle_reply_is_lost() {
    let (channel, state, observation) = observed(CloseReply::default()).await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    state.lock().unwrap().open_gate = Some(gate.clone());
    let captured = channel.clone();
    let task = tokio::spawn(async move { captured.open("/target", true).await });
    wait_for(|| state.lock().unwrap().opens == 1).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    gate.add_permits(1);
    drop(channel);
    assert!(!observation.settled());
}

#[tokio::test]
async fn reused_handle_is_not_released_by_an_older_delayed_close_reply() {
    for cancel_older in [false, true] {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let (channel, state, observation) = observed(CloseReply {
            status: 0,
            gate: Some(gate.clone()),
        })
        .await;
        let first = channel.open("/first", true).await.unwrap();
        let captured = channel.clone();
        let closing = tokio::spawn(async move { captured.close(&first).await });
        wait_for(|| state.lock().unwrap().closes == 1).await;
        let second = channel.open("/second", true).await.unwrap();
        if cancel_older {
            closing.abort();
            assert!(closing.await.unwrap_err().is_cancelled());
        } else {
            gate.add_permits(1);
            closing.await.unwrap().unwrap();
        }
        assert!(!observation.settled(), "old CLOSE released a reused handle");
        gate.add_permits(2);
        channel.close(&second).await.unwrap();
        assert_eq!(
            observation.settled(),
            !cancel_older,
            "new handle completion erased an old unobserved CLOSE"
        );
    }
}
