//! Original operation identity, canonical scopes and CAS guard continuation.
use super::mutation::{cancellation, journal, setup};
use super::*;
use crate::ssh::files::native_save::runtime::MutationReference;

#[tokio::test]
async fn cleanup_continuation_rejects_unknown_generation_destination_and_changed_alias() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(&[("/requested", Ok("/workspace/actual"))], None).await;
    let paths = vec!["/requested".into()];
    let operation = uuid::Uuid::new_v4().to_string();
    let generation = uuid::Uuid::new_v4().to_string();
    let claim = manager
        .reserve_editor_mutation(&destination, &sftp, &paths, &operation, &generation)
        .await
        .unwrap()
        .unwrap();
    let reference: MutationReference = claim.reference();
    let (job, _delivery) = cancellation();
    let active = claim.dispatch(&job).await.unwrap();
    assert!(manager
        .resume_editor_cleanup(
            &destination,
            &sftp,
            &paths,
            (&operation, &generation),
            &reference
        )
        .await
        .is_err());
    active.park_editor_cleanup().await.unwrap();
    for (id, gen) in [(&generation, &generation), (&operation, &operation)] {
        assert!(manager
            .resume_editor_cleanup(&destination, &sftp, &paths, (id, gen), &reference)
            .await
            .is_err());
    }
    let mut other = destination.clone();
    other.server_key = format!("SHA256:{}", "B".repeat(43));
    assert!(manager
        .resume_editor_cleanup(&other, &sftp, &paths, (&operation, &generation), &reference)
        .await
        .is_err());
    let (alias, _) = server(&[("/requested", Ok("/workspace/switched"))], None).await;
    assert!(manager
        .resume_editor_cleanup(
            &destination,
            &alias,
            &paths,
            (&operation, &generation),
            &reference
        )
        .await
        .is_err());
    alias.close().await.unwrap();
    let resumed = manager
        .resume_editor_cleanup(
            &destination,
            &sftp,
            &paths,
            (&operation, &generation),
            &reference,
        )
        .await
        .unwrap();
    let revision = journal(&fixture).legacy_claims().unwrap()[0].revision;
    let (cancelled, delivery) = cancellation();
    drop(delivery);
    assert!(resumed.dispatch(&cancelled).await.is_err());
    assert_eq!(
        journal(&fixture).legacy_claims().unwrap()[0].revision,
        revision
    );
    let resumed = manager
        .resume_editor_cleanup(
            &destination,
            &sftp,
            &paths,
            (&operation, &generation),
            &reference,
        )
        .await
        .unwrap();
    resumed
        .dispatch(&job)
        .await
        .unwrap()
        .settle()
        .await
        .unwrap();
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    sftp.close().await.unwrap();
}
