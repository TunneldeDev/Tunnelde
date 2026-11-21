use super::*;
use crate::services::operations::{Authority, Cancellation};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

#[derive(Default)]
struct Origin {
    retired: Mutex<bool>,
    attempts: AtomicUsize,
}
impl Authority for Origin {
    fn with_current(&self, effect: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
        let retired = self.retired.lock().unwrap();
        if *retired {
            return Err(crate::error::AppError::validation("origin.expired"));
        }
        self.attempts.fetch_add(1, Ordering::SeqCst);
        effect()
    }
}
async fn attempted(origin: &Origin) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while origin.attempts.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn retired_origin_exits_db_wait_without_policy_or_origin_lock_retention() {
    let (security, db, lease) = fixture();
    let held = Held::new(db.clone()).await;
    let origin = Arc::new(Origin::default());
    let worker = origin.clone();
    let worker_security = security.clone();
    let writer = tokio::task::spawn_blocking(move || {
        worker_security.with_authorized_fenced_database(
            &db,
            &lease,
            &["settings.write"],
            || Ok(()),
            Some(worker.as_ref()),
            |_| -> AppResult<()> { panic!("retired origin reached SQL") },
        )
    });
    attempted(&origin).await;
    // Both locks must remain available even though the DB is still occupied.
    security
        .authorize(
            "writer",
            &"a".repeat(64),
            &["settings.write".into()],
            Some("settings.write"),
            None,
        )
        .unwrap();
    *origin.retired.lock().unwrap() = true;
    let error = tokio::time::timeout(Duration::from_secs(1), writer)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.to_string(), "origin.expired");
    drop(held);
}

#[tokio::test]
async fn revoked_or_cancelled_origin_waiter_never_enters_its_database_callback() {
    for revoke in [true, false] {
        let (security, db, lease) = fixture();
        let held = Held::new(db.clone()).await;
        let origin = Arc::new(Origin::default());
        let worker = origin.clone();
        let worker_security = security.clone();
        let (cancel, pending) = Cancellation::for_test("cancelled");
        let writer = tokio::task::spawn_blocking(move || {
            worker_security.with_authorized_fenced_database(
                &db,
                &lease,
                &["settings.write"],
                || cancel.check(),
                Some(worker.as_ref()),
                |_| -> AppResult<()> { panic!("invalid request reached SQL") },
            )
        });
        attempted(&origin).await;
        if revoke {
            security.remove_grant("writer");
        } else {
            drop(pending);
        }
        let error = tokio::time::timeout(Duration::from_secs(1), writer)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            if revoke {
                "pluginSecurity.approvalRequired"
            } else {
                "cancelled"
            }
        );
        drop(held);
    }
}

#[test]
fn final_transaction_retains_original_authority_and_is_never_replayed() {
    let (security, db, lease) = fixture();
    let origin = Origin::default();
    let executed = AtomicUsize::new(0);
    let (cancel, pending) = Cancellation::for_test("cancelled");
    let result = security
        .with_authorized_fenced_database(
            &db,
            &lease,
            &["settings.write"],
            || cancel.check(),
            Some(&origin),
            |conn| {
                assert!(
                    origin.retired.try_lock().is_err(),
                    "origin must fence the actual SQL"
                );
                cancel.commit()?;
                drop(pending); // Losing the caller after commit cannot roll back the effect.
                executed.fetch_add(1, Ordering::SeqCst);
                conn.execute(
                    "INSERT INTO settings(key,value,updated_at) VALUES('fenced','once',0)",
                    [],
                )?;
                Ok(7)
            },
        )
        .unwrap();
    assert_eq!(result, 7);
    assert_eq!(executed.load(Ordering::SeqCst), 1);
    assert_eq!(origin.attempts.load(Ordering::SeqCst), 1);
    db.with(|conn| {
        assert_eq!(
            conn.query_row("SELECT value FROM settings WHERE key='fenced'", [], |r| {
                r.get::<_, String>(0)
            })?,
            "once"
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn admitted_domain_failure_is_not_retried_and_non_native_callers_keep_existing_authority() {
    let (security, db, lease) = fixture();
    let calls = AtomicUsize::new(0);
    let error = security
        .with_authorized_fenced_database(
            &db,
            &lease,
            &["settings.write"],
            || Ok(()),
            None,
            |_| -> AppResult<()> {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(crate::error::AppError::validation("conflict"))
            },
        )
        .unwrap_err();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(error.to_string(), "conflict");
    assert_eq!(
        security
            .with_authorized_fenced_database(
                &db,
                &lease,
                &["settings.write"],
                || Ok(()),
                None,
                |_| Ok(42)
            )
            .unwrap(),
        42
    );
}

mod publication;
