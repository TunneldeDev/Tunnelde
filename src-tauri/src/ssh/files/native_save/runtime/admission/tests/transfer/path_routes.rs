//! Real path resolution cannot rewrite an original task's admitted location.
use super::*;

#[tokio::test]
async fn changed_original_or_descendant_canonical_path_cannot_expand_private_claim() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (initial, _) = server(&[("/requested", Ok("/workspace/actual"))], None).await;
    let mutation = manager
        .reserve_mutation(
            &destination,
            &initial,
            Kind::Transfer,
            &["/requested".into()],
        )
        .await
        .unwrap()
        .unwrap();
    let (job, _delivery) = cancellation();
    let mut worker = mutation.dispatch(&job).await.unwrap();
    let before = journal(&fixture).legacy_claims().unwrap();
    for path in ["/requested", "/requested/child"] {
        let (changed, _) = server(&[(path, Ok("/outside/other-user"))], None).await;
        assert_eq!(
            worker
                .extend_transfer_paths(&destination, &changed, &[path.into()])
                .await
                .unwrap_err()
                .to_string(),
            "editor.nativeChanged"
        );
        assert!(journal(&fixture).legacy_claims().unwrap() == before);
        changed.close().await.unwrap();
    }
    worker.settle().await.unwrap();
    initial.close().await.unwrap();
}

#[tokio::test]
async fn new_stage_must_follow_original_parent_route_and_keeps_its_own_canonical_scope() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(
        &[
            ("/alias/file", Ok("/workspace/file")),
            ("/alias/.stage", Ok("/workspace/.stage")),
            ("/alias/.stage/part", Ok("/workspace/.stage/part")),
            ("/alias/new-stage", Ok("/outside/new-stage")),
            ("/unrelated/stage", Ok("/workspace/stage")),
        ],
        None,
    )
    .await;
    let mutation = manager
        .reserve_mutation(&destination, &sftp, Kind::Transfer, &["/alias/file".into()])
        .await
        .unwrap()
        .unwrap();
    let (job, _delivery) = cancellation();
    let mut worker = mutation.dispatch(&job).await.unwrap();
    worker
        .extend_transfer_paths(
            &destination,
            &sftp,
            &["/alias/.stage/part".into(), "/alias/.stage".into()],
        )
        .await
        .unwrap();
    let enrolled = journal(&fixture).legacy_claims().unwrap();
    for path in ["/alias/new-stage", "/unrelated/stage"] {
        assert!(worker
            .extend_transfer_paths(&destination, &sftp, &[path.into()])
            .await
            .is_err());
        assert!(journal(&fixture).legacy_claims().unwrap() == enrolled);
    }
    // A path already enrolled cannot expand its canonical coverage on retry.
    let (redirected, _) = server(&[("/alias/.stage", Ok("/outside/changed"))], None).await;
    assert!(worker
        .extend_transfer_paths(&destination, &redirected, &["/alias/.stage".into()])
        .await
        .is_err());
    assert!(journal(&fixture).legacy_claims().unwrap() == enrolled);
    redirected.close().await.unwrap();
    worker.settle().await.unwrap();
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn windows_stage_routes_normalize_drive_case_but_reject_new_drive_or_peer() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(
        &[
            (r"C:\Alias\File", Ok("/D:/Workspace/File")),
            ("/c:/alias/.stage/part", Ok(r"d:\workspace\.stage\part")),
            ("/c:/alias/.stage", Ok("D:/WORKSPACE/.STAGE")),
            ("/c:/alias/new-stage", Ok("E:/workspace/new-stage")),
            ("/c:/alias/file", Ok("D:/outside/file")),
        ],
        None,
    )
    .await;
    let original = manager
        .reserve_mutation(
            &destination,
            &sftp,
            Kind::Transfer,
            &[r"C:\Alias\File".into()],
        )
        .await
        .unwrap()
        .unwrap();
    let (job, _delivery) = cancellation();
    let mut worker = original.dispatch(&job).await.unwrap();
    worker
        .extend_transfer_paths(
            &destination,
            &sftp,
            &["/c:/alias/.stage/part".into(), "/c:/alias/.stage".into()],
        )
        .await
        .unwrap();
    let enrolled = journal(&fixture).legacy_claims().unwrap();
    for path in ["/c:/alias/new-stage", "/c:/alias/file"] {
        assert_eq!(
            worker
                .extend_transfer_paths(&destination, &sftp, &[path.into()])
                .await
                .unwrap_err()
                .to_string(),
            "editor.nativeChanged"
        );
        assert!(journal(&fixture).legacy_claims().unwrap() == enrolled);
    }
    let mut other_peer = destination.clone();
    other_peer.server_key = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA".into();
    assert!(worker
        .extend_transfer_paths(&other_peer, &sftp, &["/c:/alias/.stage".into()])
        .await
        .is_err());
    assert!(journal(&fixture).legacy_claims().unwrap() == enrolled);
    worker.settle().await.unwrap();
    sftp.close().await.unwrap();
}
