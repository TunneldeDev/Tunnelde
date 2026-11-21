use super::*;

#[test]
fn publication_releases_db_but_retains_exact_origin_and_policy_through_committed_state() {
    let (security, db, lease) = fixture();
    let origin = Origin::default();
    let (cancel, pending) = Cancellation::for_test("cancelled");
    let writes = AtomicUsize::new(0);
    let publications = AtomicUsize::new(0);
    let value = security
        .with_authorized_fenced_database_then(
            &db,
            &lease,
            &["settings.write"],
            || cancel.check(),
            Some(&origin),
            |conn| {
                assert!(origin.retired.try_lock().is_err());
                cancel.commit()?;
                conn.execute(
                    "INSERT INTO settings(key,value,updated_at) VALUES('published','durable',0)",
                    [],
                )?;
                writes.fetch_add(1, Ordering::SeqCst);
                // Losing delivery after admission must not suppress state publication.
                drop(pending);
                Ok("new-revision")
            },
            |revision| {
                assert!(
                    origin.retired.try_lock().is_err(),
                    "original origin must stay fenced"
                );
                assert!(
                    security.inner.try_lock().is_err(),
                    "revocation must not split publication"
                );
                assert_eq!(
                    db.try_with(|conn| Ok(conn.query_row(
                        "SELECT value FROM settings WHERE key='published'",
                        [],
                        |r| r.get::<_, String>(0)
                    )?))?
                    .as_deref(),
                    Some("durable")
                );
                cancel.check()?;
                publications.fetch_add(1, Ordering::SeqCst);
                Ok(revision)
            },
        )
        .unwrap();
    assert_eq!(value, "new-revision");
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    assert_eq!(publications.load(Ordering::SeqCst), 1);
    assert_eq!(origin.attempts.load(Ordering::SeqCst), 1);
    assert!(origin.retired.try_lock().is_ok());
    assert!(security.inner.try_lock().is_ok());
}

#[tokio::test]
async fn invalidated_publication_waiters_exit_while_database_is_still_occupied() {
    for invalidation in ["origin", "grant", "cancel"] {
        let (security, db, lease) = fixture();
        let held = Held::new(db.clone()).await;
        let origin = Arc::new(Origin::default());
        let worker_origin = origin.clone();
        let worker_security = security.clone();
        let (cancel, pending) = Cancellation::for_test("cancelled");
        let writer = tokio::task::spawn_blocking(move || {
            worker_security.with_authorized_fenced_database_then(
                &db,
                &lease,
                &["settings.write"],
                || cancel.check(),
                Some(worker_origin.as_ref()),
                |_| -> AppResult<()> { panic!("expired settings caller reached durable commit") },
                |_| -> AppResult<()> { panic!("expired settings caller published") },
            )
        });
        attempted(&origin).await;
        let expected = match invalidation {
            "origin" => {
                *origin.retired.lock().unwrap() = true;
                "origin.expired"
            }
            "grant" => {
                security.remove_grant("writer");
                "pluginSecurity.approvalRequired"
            }
            _ => {
                drop(pending);
                "cancelled"
            }
        };
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), writer)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .to_string(),
            expected
        );
        drop(held);
    }
}

#[test]
fn domain_and_publication_errors_are_final_not_admission_retries() {
    let (security, db, lease) = fixture();
    let origin = Origin::default();
    let writes = AtomicUsize::new(0);
    let publications = AtomicUsize::new(0);
    let failed: AppResult<()> = security.with_authorized_fenced_database_then(
        &db,
        &lease,
        &["settings.write"],
        || Ok(()),
        Some(&origin),
        |_| -> AppResult<()> {
            writes.fetch_add(1, Ordering::SeqCst);
            Err(crate::error::AppError::validation(
                "preferences.staleRevision",
            ))
        },
        |_| {
            publications.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    );
    assert_eq!(failed.unwrap_err().to_string(), "preferences.staleRevision");
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    assert_eq!(publications.load(Ordering::SeqCst), 0);
    let failed: AppResult<()> = security.with_authorized_fenced_database_then(
        &db,
        &lease,
        &["settings.write"],
        || Ok(()),
        Some(&origin),
        |conn| {
            writes.fetch_add(1, Ordering::SeqCst);
            conn.execute(
                "INSERT INTO settings(key,value,updated_at) VALUES('once','committed',0)",
                [],
            )?;
            Ok(())
        },
        |_| {
            publications.fetch_add(1, Ordering::SeqCst);
            Err(crate::error::AppError::validation("publication.failed"))
        },
    );
    assert_eq!(failed.unwrap_err().to_string(), "publication.failed");
    assert_eq!(writes.load(Ordering::SeqCst), 2);
    assert_eq!(publications.load(Ordering::SeqCst), 1);
    assert_eq!(
        db.with(|conn| Ok(conn.query_row(
            "SELECT value FROM settings WHERE key='once'",
            [],
            |r| r.get::<_, String>(0)
        )?))
        .unwrap(),
        "committed"
    );
}
