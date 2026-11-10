use std::future::pending;
use std::time::Duration;
use tokio::time::{timeout, Instant};

use super::*;

#[tokio::test]
async fn native_and_frontend_acknowledgements_are_both_required() {
    let (security, db) = fixture();
    let lease = grant(&security, &db, "dependency", &[]);
    let activation = security.begin_runtime(&lease, &[], true).unwrap();
    let mut wait = Box::pin(security.wait_ready(&lease, Instant::now() + Duration::from_secs(2)));
    assert!(timeout(Duration::from_millis(10), &mut wait).await.is_err());
    security.native_ready(&lease).unwrap();
    assert!(timeout(Duration::from_millis(10), &mut wait).await.is_err());
    security.frontend_opened(&lease, "module").unwrap();
    assert!(timeout(Duration::from_millis(10), &mut wait).await.is_err());
    security.frontend_ready(&lease, "module").unwrap();
    assert!(wait.await.is_ok());
    activation.commit();
    // Acknowledgement preceding subscription must be observed immediately.
    security.wait_ready(&lease, Instant::now()).await.unwrap();
}

#[tokio::test]
async fn caller_cancellation_does_not_stop_shared_startup() {
    let (security, db) = fixture();
    let lease = grant(&security, &db, "shared", &[]);
    let activation = security.begin_runtime(&lease, &[], false).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut first = Box::pin(security.wait_ready(&lease, deadline));
    let mut second = Box::pin(security.wait_ready(&lease, deadline));
    assert!(timeout(Duration::from_millis(10), &mut first)
        .await
        .is_err());
    assert!(timeout(Duration::from_millis(10), &mut second)
        .await
        .is_err());
    drop(first);
    security.native_ready(&lease).unwrap();
    second.await.unwrap();
    activation.commit();
    assert!(allowed(&security, &lease));
}

#[tokio::test]
async fn retirement_replacement_and_missing_runtime_cannot_satisfy_an_old_wait() {
    let (security, db) = fixture();
    let old = grant(&security, &db, "dependency", &[]);
    assert!(security.wait_ready(&old, Instant::now()).await.is_err());
    let activation = security.begin_runtime(&old, &[], false).unwrap();
    let mut wait = Box::pin(security.wait_ready(&old, Instant::now() + Duration::from_secs(2)));
    assert!(timeout(Duration::from_millis(10), &mut wait).await.is_err());
    security.retire_runtime("dependency");
    let new = security
        .lease("dependency", old.fingerprint.clone(), vec![])
        .unwrap();
    ready(&security, &new, &[]);
    assert!(timeout(Duration::from_millis(200), wait)
        .await
        .unwrap()
        .is_err());
    drop(activation);
    security.wait_ready(&new, Instant::now()).await.unwrap();
}

#[tokio::test]
async fn unrelated_policy_notifications_do_not_extend_absolute_deadline() {
    let (security, db) = fixture();
    let lease = grant(&security, &db, "dependency", &[]);
    let activation = security.begin_runtime(&lease, &[], false).unwrap();
    let deadline = Instant::now() + Duration::from_millis(30);
    let wait = security.wait_ready(&lease, deadline);
    let noise = async {
        loop {
            let other = grant(&security, &db, "other", &[]);
            ready(&security, &other, &[]);
            security.retire_runtime("other");
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    };
    tokio::select! {
        result = timeout(Duration::from_secs(2), wait) => {
            assert_eq!(result.unwrap().unwrap_err().to_string(), "plugin.timeout");
        }
        _ = noise => unreachable!(),
    }
    assert!(allowed(&security, &lease));
    drop(activation);
}

#[tokio::test]
async fn loss_of_frontend_readiness_cancels_even_if_reactivated_before_next_poll() {
    let (security, db) = fixture();
    let lease = grant(&security, &db, "dependency", &[]);
    let activation = security.begin_runtime(&lease, &[], true).unwrap();
    security.native_ready(&lease).unwrap();
    security.frontend_opened(&lease, "module").unwrap();
    security.frontend_ready(&lease, "module").unwrap();
    activation.commit();
    let result = security
        .guard_ready(&lease, async {
            security.frontend_closed(&lease, "module");
            security.frontend_opened(&lease, "module").unwrap();
            security.frontend_ready(&lease, "module").unwrap();
            Ok("retired output")
        })
        .await;
    assert!(result.is_err());
    assert_eq!(
        security
            .guard_ready(&lease, async { Ok("current") })
            .await
            .unwrap(),
        "current"
    );
}

#[tokio::test]
async fn admitted_operation_is_cancelled_on_stop_or_dependency_loss() {
    let (security, db) = fixture();
    let dependency = grant(&security, &db, "dependency", &[]);
    ready(&security, &dependency, &[]);
    let owner = grant(&security, &db, "owner", &[]);
    ready(&security, &owner, &[dependency]);
    let mut operation =
        Box::pin(security.guard_ready(&owner, pending::<crate::error::AppResult<()>>()));
    assert!(timeout(Duration::from_millis(10), &mut operation)
        .await
        .is_err());
    security.retire_runtime("dependency");
    assert!(timeout(Duration::from_millis(200), operation)
        .await
        .unwrap()
        .is_err());
}
