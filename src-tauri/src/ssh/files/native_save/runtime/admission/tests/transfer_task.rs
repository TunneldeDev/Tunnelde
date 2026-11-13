//! Recover the immutable operation from private SQLite, never from UI history.
use super::mutation::{cancellation, journal, setup};
use super::*;
use crate::ssh::files::native_save::{
    journal::admission::{TaskEndpoint, TransferTask},
    runtime::mutation::MutationTarget,
};

fn task(destination: &SessionIdentity) -> TransferTask {
    TransferTask {
        id: uuid::Uuid::new_v4().to_string(),
        source: TaskEndpoint {
            path: "C:/input.json".into(),
            remote: None,
        },
        destination: TaskEndpoint {
            path: "/requested".into(),
            remote: Some(destination.clone()),
        },
        remove_source: false,
        overwrite: false,
        plugin_id: None,
    }
}

#[tokio::test]
async fn original_task_reopens_without_the_application_projection_and_rejects_changed_intent() {
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
    let paths = vec!["/requested".into()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &paths,
    }];
    let task = task(&destination);
    let reserved = manager
        .reserve_transfer_task(&targets, task.clone(), &uuid::Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    let reference = reserved.transfer_reference().unwrap();
    assert!(manager.transfer_task_reference(&task).await.unwrap() == Some(reference.clone()));
    // Simulate losing delivery before linking any application row: the original
    // private claim still owns the intent and can be found after reopening.
    drop(reserved);
    drop(manager);
    let manager = fixture.manager();
    let restored = manager
        .transfer_task_reference(&task)
        .await
        .unwrap()
        .unwrap();
    assert!(reference == restored);
    for variant in 0..7 {
        let mut changed = task.clone();
        match variant {
            0 => changed.source.path = "C:/another.json".into(),
            1 => changed.destination.path = "/other".into(),
            2 => changed.overwrite = true,
            3 => changed.remove_source = true,
            4 => changed.plugin_id = Some("another-plugin".into()),
            5 => {
                changed.destination.remote.as_mut().unwrap().server_key =
                    "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA".into()
            }
            6 => changed.source.remote = Some(destination.clone()),
            _ => unreachable!(),
        }
        assert!(manager.transfer_task_reference(&changed).await.is_err());
    }
    let continuation = manager
        .resume_transfer_mutation(&restored, &targets)
        .await
        .unwrap();
    let (job, _delivery) = cancellation();
    let mut active = continuation
        .dispatch_transfer(&restored, &job)
        .await
        .unwrap();
    assert!(manager.transfer_task_reference(&task).await.is_err());
    let parked = active.park().await.unwrap();
    assert!(manager.transfer_task_reference(&task).await.unwrap() == Some(parked.clone()));
    let resumed = manager
        .resume_transfer_mutation(&parked, &targets)
        .await
        .unwrap();
    let (job, _delivery) = cancellation();
    resumed
        .dispatch_transfer(&parked, &job)
        .await
        .unwrap()
        .settle()
        .await
        .unwrap();
    assert!(manager
        .transfer_task_reference(&task)
        .await
        .unwrap()
        .is_none());
    assert!(journal(&fixture).legacy_claims().unwrap().is_empty());
    sftp.close().await.unwrap();
}

#[tokio::test]
async fn older_unbound_claim_is_not_adopted_as_a_task_from_its_owner_id() {
    let (fixture, destination) = setup();
    let manager = fixture.manager();
    let (sftp, _) = server(&[("/requested", Ok("/workspace/actual"))], None).await;
    let paths = vec!["/requested".into()];
    let targets = [MutationTarget {
        destination: &destination,
        sftp: &sftp,
        paths: &paths,
    }];
    let task = task(&destination);
    let old = manager
        .reserve_transfer_mutation(&targets, (&task.id, &uuid::Uuid::new_v4().to_string()))
        .await
        .unwrap()
        .unwrap();
    assert!(manager.transfer_task_reference(&task).await.is_err());
    assert!(journal(&fixture).legacy_claims().unwrap()[0]
        .transfer_task
        .is_none());
    old.retire().await.unwrap();
    sftp.close().await.unwrap();
}
