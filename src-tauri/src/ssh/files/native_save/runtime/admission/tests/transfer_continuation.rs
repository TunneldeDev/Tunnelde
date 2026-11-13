//! The real manager/SQLite/SFTP stack retains exact parked transfer ownership.
use super::mutation::{cancellation, journal, setup};
use super::*;
use crate::ssh::files::native_save::{
    journal::admission::Phase,
    runtime::mutation::{MutationTarget, TransferReference},
};

#[tokio::test]
async fn parked_transfer_reopens_with_exact_revision_roots_and_a_fresh_request_epoch() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(
        &[
            ("/requested", Ok("/workspace/actual")),
            ("/workspace/actual", Ok("/workspace/actual")),
            ("/generated", Ok("/workspace/.stage")),
            ("/workspace/.stage", Ok("/workspace/.stage")),
        ],
        None,
    )
    .await;
    let roots = vec!["/requested".into()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &roots,
    }];
    let owner = (
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    );
    let initial = manager
        .reserve_transfer_mutation(&targets, (&owner.0, &owner.1))
        .await
        .unwrap()
        .unwrap();
    let first_reference = initial.transfer_reference().unwrap();
    let (job, _delivery) = cancellation();
    let mut attempt = initial
        .dispatch_transfer(&first_reference, &job)
        .await
        .unwrap();
    let old_channel = attempt.observation();
    assert!(old_channel
        .request(sftp.create_dir("/requested"))
        .await
        .is_err());
    assert!(old_channel.settled(), "typed terminal rejection is known");
    attempt
        .extend_paths(&destination, &sftp, &["/generated".into()])
        .await
        .unwrap();
    let parked = attempt.park().await.unwrap();
    assert!(parked != first_reference);
    assert!(
        old_channel.begin().is_none(),
        "old queued writers cannot run after parking"
    );
    let claims = journal(&fixture).legacy_claims().unwrap();
    assert_eq!(claims.len(), 1);
    assert!(claims[0].phase == Phase::Recoverable);
    assert_eq!(claims[0].revision, 5);
    drop(manager);
    let manager = fixture.manager();
    assert!(manager
        .resume_transfer_mutation(&first_reference, &targets)
        .await
        .is_err());
    assert!(manager
        .writable(&destination, &sftp, &["/generated"])
        .await
        .is_err());
    let continuation = manager
        .resume_transfer_mutation(&parked, &targets)
        .await
        .unwrap();
    let (job, _delivery) = cancellation();
    let current = continuation.dispatch_transfer(&parked, &job).await.unwrap();
    let fresh_channel = current.observation();
    fresh_channel.request(async { Ok(()) }).await.unwrap();
    assert!(old_channel.request(async { Ok(()) }).await.is_err());
    current.settle().await.unwrap();
    assert!(fresh_channel.begin().is_none());
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn unknown_original_request_keeps_transfer_dispatched_and_blocks_continuation() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(&[("/requested", Ok("/workspace/actual"))], None).await;
    let roots = vec!["/requested".into()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &roots,
    }];
    let owner = (
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    );
    let initial = manager
        .reserve_transfer_mutation(&targets, (&owner.0, &owner.1))
        .await
        .unwrap()
        .unwrap();
    let reference = initial.transfer_reference().unwrap();
    let (job, _delivery) = cancellation();
    let attempt = initial.dispatch_transfer(&reference, &job).await.unwrap();
    let observed = attempt.observation();
    let result: Result<(), _> = observed
        .request(async { Err(russh_sftp::client::error::Error::Timeout) })
        .await;
    assert!(result.is_err());
    assert!(attempt.park().await.is_err());
    let claims = journal(&fixture).legacy_claims().unwrap();
    assert!(claims[0].phase == Phase::Dispatched);
    let error = manager
        .resume_transfer_mutation(&reference, &targets)
        .await
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "editor.remoteOutcomeUnknown");
    assert!(manager
        .writable(&destination, &sftp, &["/requested"])
        .await
        .is_err());
    observed.request(async { Ok(()) }).await.unwrap();
    assert!(
        !observed.settled(),
        "unrelated success cannot retire the original timeout"
    );
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn changed_owner_revision_root_endpoint_or_generated_alias_cannot_resume_a_transfer() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(
        &[
            ("/requested", Ok("/workspace/actual")),
            ("/workspace/actual", Ok("/workspace/actual")),
            ("/generated", Ok("/workspace/.stage")),
            ("/workspace/.stage", Ok("/workspace/.stage")),
        ],
        None,
    )
    .await;
    let roots = vec!["/requested".into()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &roots,
    }];
    let owner = (
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    );
    let initial = manager
        .reserve_transfer_mutation(&targets, (&owner.0, &owner.1))
        .await
        .unwrap()
        .unwrap();
    let reference = initial.transfer_reference().unwrap();
    let (job, _delivery) = cancellation();
    let mut attempt = initial.dispatch_transfer(&reference, &job).await.unwrap();
    attempt
        .extend_paths(&destination, &sftp, &["/generated".into()])
        .await
        .unwrap();
    let parked = attempt.park().await.unwrap();
    let value = serde_json::to_value(&parked).unwrap();
    for key in ["journalId", "claimId"] {
        let mut changed = value.clone();
        changed[key] = uuid::Uuid::new_v4().to_string().into();
        let reference: TransferReference = serde_json::from_value(changed).unwrap();
        assert!(manager
            .resume_transfer_mutation(&reference, &targets)
            .await
            .is_err());
    }
    let mut changed = value.clone();
    changed["owner"]["generation"] = uuid::Uuid::new_v4().to_string().into();
    let reference = serde_json::from_value(changed).unwrap();
    assert!(manager
        .resume_transfer_mutation(&reference, &targets)
        .await
        .is_err());
    let mut changed = value.clone();
    changed["revision"] = 1.into();
    let reference = serde_json::from_value(changed).unwrap();
    assert!(manager
        .resume_transfer_mutation(&reference, &targets)
        .await
        .is_err());
    let mut changed_destination = destination.clone();
    changed_destination.server_key = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA".into();
    let changed_targets = [MutationTarget {
        destination: &changed_destination,
        sftp: &sftp,
        paths: &roots,
    }];
    assert!(manager
        .resume_transfer_mutation(&parked, &changed_targets)
        .await
        .is_err());
    let changed_roots = vec!["/generated".into()];
    let changed_targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &changed_roots,
    }];
    assert!(manager
        .resume_transfer_mutation(&parked, &changed_targets)
        .await
        .is_err());
    let (redirected, _) = server(
        &[
            ("/requested", Ok("/workspace/actual")),
            ("/workspace/actual", Ok("/workspace/actual")),
            ("/generated", Ok("/workspace/unreserved")),
        ],
        None,
    )
    .await;
    let redirected_targets = [MutationTarget {
        destination: &destination,
        sftp: &redirected,
        paths: &roots,
    }];
    assert!(manager
        .resume_transfer_mutation(&parked, &redirected_targets)
        .await
        .is_err());
    assert_eq!(journal(&fixture).legacy_claims().unwrap()[0].revision, 5);
    let continuation = manager
        .resume_transfer_mutation(&parked, &targets)
        .await
        .unwrap();
    continuation
        .dispatch_transfer(&parked, &job)
        .await
        .unwrap()
        .settle()
        .await
        .unwrap();
    sftp.close().await.unwrap();
    redirected.close().await.unwrap();
}

#[tokio::test]
async fn only_one_continuation_dispatches_and_cancellation_preserves_the_parked_claim() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(
        &[
            ("/requested", Ok("/workspace/actual")),
            ("/workspace/actual", Ok("/workspace/actual")),
        ],
        None,
    )
    .await;
    let roots = vec!["/requested".into()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &roots,
    }];
    let owner = (
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    );
    let initial = manager
        .reserve_transfer_mutation(&targets, (&owner.0, &owner.1))
        .await
        .unwrap()
        .unwrap();
    let reference = initial.transfer_reference().unwrap();
    let (job, _delivery) = cancellation();
    let parked = initial
        .dispatch_transfer(&reference, &job)
        .await
        .unwrap()
        .park()
        .await
        .unwrap();
    let cancelled = manager
        .resume_transfer_mutation(&parked, &targets)
        .await
        .unwrap();
    let (cancelled_job, delivery) = cancellation();
    drop(delivery);
    assert!(cancelled
        .dispatch_transfer(&parked, &cancelled_job)
        .await
        .is_err());
    assert!(journal(&fixture).legacy_claims().unwrap()[0].phase == Phase::Recoverable);
    let first = manager
        .resume_transfer_mutation(&parked, &targets)
        .await
        .unwrap();
    let second = fixture
        .manager()
        .resume_transfer_mutation(&parked, &targets)
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        first.dispatch_transfer(&parked, &job),
        second.dispatch_transfer(&parked, &job)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let winner = a.ok().or_else(|| b.ok()).unwrap();
    winner.settle().await.unwrap();
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    sftp.close().await.unwrap();
}
