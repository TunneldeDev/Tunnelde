//! Actual manager/SQLite/SFTP preparation keeps generated paths with one worker.
use super::mutation::{cancellation, journal, setup};
use super::*;
use crate::ssh::files::native_save::journal::admission::Kind;
use crate::ssh::files::native_save::{journal::Owner, runtime::mutation::MutationTarget};
mod path_routes;

#[tokio::test]
async fn original_transfer_worker_extends_generated_paths_and_settles_the_current_revision() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(
        &[
            ("/requested", Ok("/workspace/actual")),
            ("/generated", Ok("/workspace/.task-stage")),
            ("/unrelated", Ok("/workspace/unrelated")),
        ],
        None,
    )
    .await;
    let original = manager
        .reserve_mutation(&destination, &sftp, Kind::Transfer, &["/requested".into()])
        .await
        .unwrap()
        .unwrap();
    let (job, _delivery) = cancellation();
    let mut active = original.dispatch(&job).await.unwrap();
    active
        .extend_transfer_paths(&destination, &sftp, &["/generated".into()])
        .await
        .unwrap();
    let claims = journal(&fixture).legacy_claims().unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].revision, 4);
    assert_eq!(
        claims[0].scopes[0].paths,
        [
            "/requested",
            "/workspace/actual",
            "/generated",
            "/workspace/.task-stage"
        ]
    );
    assert!(manager
        .writable(&destination, &sftp, &["/generated"])
        .await
        .is_err());
    manager
        .writable(&destination, &sftp, &["/unrelated"])
        .await
        .unwrap();
    active.settle().await.unwrap();
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn rejected_extension_keeps_the_original_live_permit_and_scope() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(
        &[
            ("/requested", Ok("/workspace/actual")),
            ("/occupied", Ok("/workspace/occupied")),
        ],
        None,
    )
    .await;
    let original = manager
        .reserve_mutation(&destination, &sftp, Kind::Transfer, &["/requested".into()])
        .await
        .unwrap()
        .unwrap();
    let _occupied = manager
        .reserve_mutation(&destination, &sftp, Kind::Mkdir, &["/occupied".into()])
        .await
        .unwrap()
        .unwrap();
    let (job, _delivery) = cancellation();
    let mut active = original.dispatch(&job).await.unwrap();
    assert!(active
        .extend_transfer_paths(&destination, &sftp, &["/occupied".into()])
        .await
        .is_err());
    active.settle().await.unwrap();
    let claims = journal(&fixture).legacy_claims().unwrap();
    assert_eq!(claims.len(), 1);
    assert!(claims[0].kind == Kind::Mkdir);
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn all_mutated_transfer_endpoints_are_reserved_in_one_transaction_or_not_at_all() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let mut other = destination.clone();
    other.host_id = "other-host".into();
    other.address = "user@other-host:22".into();
    other.server_key = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA".into();
    let (sftp, _) = server(&[("/requested", Ok("/workspace/actual"))], None).await;
    let paths = vec!["/requested".into()];
    let targets = [
        MutationTarget {
            destination: &destination,
            sftp: &sftp,
            paths: &paths,
        },
        MutationTarget {
            destination: &other,
            sftp: &sftp,
            paths: &paths,
        },
    ];
    let owner = Owner {
        id: uuid::Uuid::new_v4().to_string(),
        generation: uuid::Uuid::new_v4().to_string(),
    };
    let occupied = manager
        .reserve_mutation(&other, &sftp, Kind::Editor, &paths)
        .await
        .unwrap()
        .unwrap();
    assert!(manager
        .reserve_transfer_mutation(&targets, (&owner.id, &owner.generation))
        .await
        .is_err());
    let claims = journal(&fixture).legacy_claims().unwrap();
    assert_eq!(claims.len(), 1);
    assert!(claims[0].kind == Kind::Editor);
    occupied.retire().await.unwrap();
    let reserved = manager
        .reserve_transfer_mutation(&targets, (&owner.id, &owner.generation))
        .await
        .unwrap()
        .unwrap();
    let claims = journal(&fixture).legacy_claims().unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].scopes.len(), 2);
    for identity in [&destination, &other] {
        assert!(manager
            .writable(identity, &sftp, &["/requested"])
            .await
            .is_err());
    }
    reserved.retire().await.unwrap();
    sftp.close().await.unwrap();
}
