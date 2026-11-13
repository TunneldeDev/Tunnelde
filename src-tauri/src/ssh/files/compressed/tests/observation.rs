use super::*;

async fn observed() -> (Arc<Session>, BufReader<DuplexStream>, MutationObservation) {
    let (client, mut server) = duplex(1024 * 1024);
    server.write_all(MAGIC).await.unwrap();
    let observation = MutationObservation::default();
    let session = Arc::new(
        Session::new_observed(client, observation.clone())
            .await
            .unwrap(),
    );
    (session, BufReader::new(server), observation)
}

async fn receive(peer: &mut BufReader<DuplexStream>) -> Value {
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(2), peer.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let header: Value = serde_json::from_str(&line).unwrap();
    let mut payload = vec![0; header["size"].as_u64().unwrap() as usize];
    peer.read_exact(&mut payload).await.unwrap();
    header
}

async fn reply(peer: &mut BufReader<DuplexStream>, id: &Value, mut reply: Value) {
    reply["id"] = id.clone();
    peer.get_mut()
        .write_all(format!("{reply}\n").as_bytes())
        .await
        .unwrap();
    if let Some(size) = reply["size"].as_u64().filter(|s| *s > 0) {
        peer.get_mut()
            .write_all(&vec![0; size as usize])
            .await
            .unwrap();
    }
}

async fn settled(observation: &MutationObservation) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while !observation.settled() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("original wire reply did not settle its observation");
}

#[tokio::test]
async fn sealed_transfer_epoch_rejects_queued_mutations_without_breaking_readonly_requests() {
    let (session, mut peer, observation) = observed().await;
    observation.seal().unwrap();
    assert!(session.open("/must-not-be-created", true).await.is_err());
    assert!(session.write("old-handle", 0, vec![7; 19]).await.is_err());
    assert!(session
        .create_private_directory("/must-not-be-created")
        .await
        .is_err());
    let mut line = String::new();
    assert!(
        tokio::time::timeout(Duration::from_millis(20), peer.read_line(&mut line))
            .await
            .is_err()
    );
    assert!(
        line.is_empty(),
        "sealed mutations must never reach the peer"
    );
    let captured = session.clone();
    let reader = tokio::spawn(async move { captured.open("/readonly", false).await });
    let request = receive(&mut peer).await;
    assert_eq!(request["op"], "open");
    assert_eq!(request["write"], false);
    reply(
        &mut peer,
        &request["id"],
        json!({"size":0,"handle":"read-only"}),
    )
    .await;
    assert_eq!(reader.await.unwrap().unwrap(), "read-only");
    assert!(observation.settled());
}

#[tokio::test]
async fn original_worker_observes_late_mkdir_write_and_archive_replies_after_caller_loss() {
    for op in ["mkdir_private", "write", "archive_write"] {
        let (session, mut peer, observation) = observed().await;
        let captured = session.clone();
        let task = tokio::spawn(async move {
            match op {
                "mkdir_private" => captured
                    .create_private_directory("/stage")
                    .await
                    .map(|_| ()),
                "write" => captured.write("1", 0, vec![7; 19]).await,
                _ => {
                    captured
                        .write_archive(
                            vec![super::super::super::archive::Entry {
                                path: "/stage/file".into(),
                                length: 19,
                            }],
                            vec![vec![7; 19]],
                            false,
                        )
                        .await
                }
            }
        });
        let request = receive(&mut peer).await;
        assert_eq!(request["op"], op);
        assert!(!observation.settled());
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        reply(&mut peer, &request["id"], json!({"size":0})).await;
        settled(&observation).await;
    }
}

#[tokio::test]
async fn lost_write_open_reply_keeps_its_live_handle_until_the_original_close() {
    let (session, mut peer, observation) = observed().await;
    let captured = session.clone();
    let opening = tokio::spawn(async move { captured.open("/stage/file", true).await });
    let request = receive(&mut peer).await;
    opening.abort();
    assert!(opening.await.unwrap_err().is_cancelled());
    reply(&mut peer, &request["id"], json!({"size":0,"handle":"1"})).await;
    // Send another request so its reply can only arrive after OPEN was observed.
    let captured = session.clone();
    let writing = tokio::spawn(async move { captured.write("1", 0, vec![4; 19]).await });
    let request = receive(&mut peer).await;
    reply(&mut peer, &request["id"], json!({"size":0})).await;
    writing.await.unwrap().unwrap();
    assert!(
        !observation.settled(),
        "OPEN lost to its caller still owns the remote handle"
    );
    let captured = session.clone();
    let closing = tokio::spawn(async move { captured.close("1").await });
    let request = receive(&mut peer).await;
    closing.abort();
    assert!(closing.await.unwrap_err().is_cancelled());
    reply(&mut peer, &request["id"], json!({"size":0})).await;
    settled(&observation).await;
}

#[tokio::test]
async fn rejected_close_and_shutdown_preserve_the_writable_handle_receipt() {
    let (session, mut peer, observation) = observed().await;
    let captured = session.clone();
    let opening = tokio::spawn(async move { captured.open("/stage/file", true).await });
    let request = receive(&mut peer).await;
    reply(&mut peer, &request["id"], json!({"size":0,"handle":"1"})).await;
    opening.await.unwrap().unwrap();
    let captured = session.clone();
    let closing = tokio::spawn(async move { captured.close("1").await });
    let request = receive(&mut peer).await;
    reply(
        &mut peer,
        &request["id"],
        json!({"size":0,"error":"close failed"}),
    )
    .await;
    assert!(closing.await.unwrap().is_err());
    assert!(!observation.settled());
    drop(session);
    assert!(!observation.settled());
}

#[tokio::test]
async fn older_close_reply_cannot_retire_a_reused_compressed_handle() {
    let (session, mut peer, observation) = observed().await;
    let captured = session.clone();
    let opening = tokio::spawn(async move { captured.open("/first", true).await });
    let request = receive(&mut peer).await;
    reply(&mut peer, &request["id"], json!({"size":0,"handle":"1"})).await;
    opening.await.unwrap().unwrap();
    let captured = session.clone();
    let closing_first = tokio::spawn(async move { captured.close("1").await });
    let first_close = receive(&mut peer).await;
    let captured = session.clone();
    let opening = tokio::spawn(async move { captured.open("/second", true).await });
    let request = receive(&mut peer).await;
    reply(&mut peer, &request["id"], json!({"size":0,"handle":"1"})).await;
    opening.await.unwrap().unwrap();
    reply(&mut peer, &first_close["id"], json!({"size":0})).await;
    closing_first.await.unwrap().unwrap();
    assert!(!observation.settled());
    let captured = session.clone();
    let closing = tokio::spawn(async move { captured.close("1").await });
    let request = receive(&mut peer).await;
    reply(&mut peer, &request["id"], json!({"size":0})).await;
    closing.await.unwrap().unwrap();
    assert!(observation.settled());
}

#[tokio::test]
async fn terminal_worker_rejections_settle_only_the_original_completed_operation() {
    let (session, mut peer, observation) = observed().await;
    let captured = session.clone();
    let earlier = tokio::spawn(async move { captured.create_private_directory("/earlier").await });
    let first = receive(&mut peer).await;
    earlier.abort();
    assert!(earlier.await.unwrap_err().is_cancelled());
    let captured = session.clone();
    let later = tokio::spawn(async move { captured.create_private_directory("/later").await });
    let second = receive(&mut peer).await;
    reply(
        &mut peer,
        &second["id"],
        json!({"size":0,"error":"permission denied"}),
    )
    .await;
    assert!(matches!(
        later.await.unwrap().unwrap(),
        range_io::DirectoryCreation::Rejected(_)
    ));
    assert!(
        !observation.settled(),
        "a later rejection must not settle an earlier request"
    );
    reply(
        &mut peer,
        &first["id"],
        json!({"size":0,"error":"already exists"}),
    )
    .await;
    settled(&observation).await;
}

#[tokio::test]
async fn malformed_or_lost_original_mutation_replies_never_acknowledge_ownership() {
    for malformed in [
        None,
        Some(json!({"size":1})),
        Some(json!({"size":0,"handle":"unexpected"})),
        Some(json!({"size":0,"length":0})),
        Some(json!({"size":0,"compressed":true})),
        Some(json!({"size":0,"error":"rejected","handle":"unexpected"})),
    ] {
        let (session, mut peer, observation) = observed().await;
        let captured = session.clone();
        let task = tokio::spawn(async move { captured.write("1", 0, vec![3; 11]).await });
        let request = receive(&mut peer).await;
        assert!(!observation.settled());
        if let Some(malformed) = malformed {
            reply(&mut peer, &request["id"], malformed).await;
        } else {
            drop(peer);
        }
        assert!(tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        drop(session);
        assert!(!observation.settled());
    }
}

#[tokio::test]
async fn cancelled_unsent_work_and_readonly_failures_do_not_reserve_mutations() {
    let (session, mut peer, observation) = observed().await;
    let slots = session.slots.clone().acquire_many_owned(64).await.unwrap();
    let captured = session.clone();
    let task = tokio::spawn(async move { captured.create_private_directory("/unsent").await });
    tokio::task::yield_now().await;
    assert!(!task.is_finished());
    assert!(observation.settled());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    drop(slots);
    let captured = session.clone();
    let reading = tokio::spawn(async move { captured.open("/readonly", false).await });
    let request = receive(&mut peer).await;
    assert_eq!(request["path"], "/readonly");
    reply(
        &mut peer,
        &request["id"],
        json!({"size":0,"error":"no such file"}),
    )
    .await;
    assert!(reading.await.unwrap().is_err());
    assert!(observation.settled());
}
