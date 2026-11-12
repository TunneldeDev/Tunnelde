//! Exercise the production manager against actual SFTP protocol resolution.
use super::*;
use crate::services::files::operations::{Budget, Cancellation, Errors};
use crate::ssh::files::native_save::{
    journal::admission::{Kind, Phase},
    testing::prepared,
};
use tokio::sync::{oneshot, Notify};

fn setup() -> (Fixture, SessionIdentity) {
    let fixture = Fixture::new();
    let mut journal = fixture.journal();
    journal.enable_admission().unwrap();
    let authority = authority();
    let destination = binding(&authority, &prepared(&authority)).destination;
    drop(journal);
    (fixture, destination)
}
fn journal(fixture: &Fixture) -> Journal {
    Journal::open(&fixture.0.join("native-file-saves")).unwrap()
}
fn cancellation() -> (Cancellation, impl Drop) {
    Cancellation::for_test("cancelled")
}

#[tokio::test]
async fn worker_success_releases_exact_claim_but_failure_retains_original_after_reopen() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(&[("/requested", Ok("/workspace/actual"))], None).await;
    let (job, _delivery) = cancellation();
    manager
        .mutate(
            &destination,
            &sftp,
            Kind::Create,
            &["/requested".into()],
            &job,
            || async { Ok(()) },
        )
        .await
        .unwrap();
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    let (job, _delivery) = cancellation();
    let error = manager
        .mutate(
            &destination,
            &sftp,
            Kind::Create,
            &["/requested".into()],
            &job,
            || async { Err(AppError::validation("simulated transport failure")) },
        )
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "simulated transport failure");
    let claims = journal(&fixture).legacy_claims().unwrap();
    assert_eq!(claims.len(), 1);
    assert!(claims[0].phase == Phase::Dispatched);
    assert_eq!(
        claims[0].scopes[0].paths,
        ["/requested", "/workspace/actual"]
    );
    let pending = fixture.manager().pending().await;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].action, Some("inspect"));
    assert_eq!(
        pending[0].error.as_deref(),
        Some("editor.remoteOutcomeUnknown")
    );
    assert!(manager
        .writable(&destination, &sftp, &["/workspace/actual/child"])
        .await
        .is_err());
    assert!(manager
        .writable(&destination, &sftp, &["/requested"])
        .await
        .is_err());
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn caller_cancellation_keeps_actual_worker_claim_until_original_success() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(&[("/requested", Ok("/workspace/actual"))], None).await;
    let sftp = Arc::new(sftp);
    let release = Arc::new(Notify::new());
    let (started, ready) = oneshot::channel();
    let budget = Arc::new(Budget::new(
        1,
        Errors {
            domain: "qa",
            busy: "busy",
            cancelled: "cancelled",
            failed: "failed",
        },
    ));
    let delivery = {
        let manager = manager.clone();
        let sftp = sftp.clone();
        let release = release.clone();
        let budget = budget.clone();
        tokio::spawn(async move {
            budget
                .asynchronous(move |job| async move {
                    manager
                        .mutate(
                            &destination,
                            &sftp,
                            Kind::Mkdir,
                            &["/requested".into()],
                            &job,
                            || async move {
                                started.send(()).unwrap();
                                release.notified().await;
                                Ok(())
                            },
                        )
                        .await
                })
                .await
        })
    };
    ready.await.unwrap();
    assert!(manager.pending().await[0].running);
    assert_eq!(journal(&fixture).legacy_claims().unwrap().len(), 1);
    delivery.abort();
    assert!(delivery.await.unwrap_err().is_cancelled());
    assert!(manager.pending().await[0].running);
    assert_eq!(journal(&fixture).legacy_claims().unwrap().len(), 1);
    assert_eq!(
        budget
            .asynchronous(|_| async { Ok(()) })
            .await
            .unwrap_err()
            .to_string(),
        "busy"
    );
    release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if journal(&fixture).legacy_claims().unwrap().is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // Wait for the actual worker's final slot drop as well as its disk commit.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if budget.asynchronous(|_| async { Ok(()) }).await.is_ok() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn cancellation_during_resolution_retires_only_unsent_claim_and_never_polls_mutation() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let gate = Arc::new(Semaphore::new(0));
    let (sftp, probes) = server(
        &[("/requested", Ok("/workspace/actual"))],
        Some(gate.clone()),
    )
    .await;
    let sftp = Arc::new(sftp);
    let (job, delivery) = cancellation();
    let polled = Arc::new(AtomicBool::new(false));
    let worker = {
        let manager = manager.clone();
        let sftp = sftp.clone();
        let polled = polled.clone();
        tokio::spawn(async move {
            manager
                .mutate(
                    &destination,
                    &sftp,
                    Kind::Delete,
                    &["/requested".into()],
                    &job,
                    || async {
                        polled.store(true, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .await
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while probes.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(delivery);
    gate.add_permits(1);
    assert_eq!(worker.await.unwrap().unwrap_err().to_string(), "cancelled");
    assert!(!polled.load(Ordering::SeqCst));
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn missing_store_and_read_compatible_v1_do_not_silently_upgrade() {
    for old in [false, true] {
        let fixture = Fixture::new();
        if old {
            drop(fixture.journal());
        }
        let manager = fixture.manager();
        let authority = authority();
        let destination = binding(&authority, &prepared(&authority)).destination;
        let (sftp, probes) = server(&[], None).await;
        let (job, _delivery) = cancellation();
        manager
            .mutate(
                &destination,
                &sftp,
                Kind::Create,
                &["/requested".into()],
                &job,
                || async { Ok(()) },
            )
            .await
            .unwrap();
        assert_eq!(probes.load(Ordering::SeqCst), 0);
        if old {
            assert!(!journal(&fixture).admission_enabled().unwrap());
        } else {
            assert!(!fixture.0.join("native-file-saves").exists());
        }
        sftp.close().await.unwrap();
    }
}
