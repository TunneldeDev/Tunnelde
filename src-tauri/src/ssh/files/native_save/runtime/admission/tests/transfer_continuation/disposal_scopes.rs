//! Cleanup validates existing private scopes without enrolling app-supplied paths.
use super::*;

#[tokio::test]
async fn disposal_path_validation_never_expands_claim_or_accepts_changed_canonical_peer() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(
        &[
            ("/requested", Ok("/workspace/actual")),
            ("/generated", Ok("/workspace/.stage")),
            ("/generated/child", Ok("/workspace/.stage/child")),
            ("/unrelated", Ok("/workspace/other")),
        ],
        None,
    )
    .await;
    let paths = vec!["/requested".into()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &paths,
    }];
    let owner = (
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    );
    let mutation = manager
        .reserve_transfer_mutation(&targets, (&owner.0, &owner.1))
        .await
        .unwrap()
        .unwrap();
    let reference = mutation.transfer_reference().unwrap();
    let (job, _delivery) = cancellation();
    let mut transfer = mutation.dispatch_transfer(&reference, &job).await.unwrap();
    assert!(transfer
        .validate_paths(&destination, &sftp, &["/generated".into()])
        .await
        .is_err());
    transfer
        .extend_paths(&destination, &sftp, &["/generated".into()])
        .await
        .unwrap();
    let before = journal(&fixture).legacy_claims().unwrap();
    transfer
        .validate_paths(
            &destination,
            &sftp,
            &["/generated".into(), "/generated/child".into()],
        )
        .await
        .unwrap();
    assert!(transfer
        .validate_paths(&destination, &sftp, &["/unrelated".into()])
        .await
        .is_err());
    let mut other_peer = destination.clone();
    other_peer.server_key = "changed-server-key".into();
    assert!(transfer
        .validate_paths(&other_peer, &sftp, &["/generated".into()])
        .await
        .is_err());
    let (retargeted, _) = server(&[("/generated", Ok("/unrelated/elsewhere"))], None).await;
    assert!(transfer
        .validate_paths(&destination, &retargeted, &["/generated".into()])
        .await
        .is_err());
    assert!(journal(&fixture).legacy_claims().unwrap() == before);
    transfer.park().await.unwrap();
    assert!(transfer
        .validate_paths(&destination, &sftp, &["/generated".into()])
        .await
        .is_err());
    retargeted.close().await.unwrap();
    sftp.close().await.unwrap();
}
