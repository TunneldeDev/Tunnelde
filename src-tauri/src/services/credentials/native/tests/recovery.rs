use super::*;

fn queue_failed_deletions(
    db: &Database,
    platform: &Mock,
    service: &Service<'_, Mock>,
    count: usize,
) {
    db.with(|conn| {
        transaction(conn, |conn| {
            for n in 0..count {
                bindings::invalidate(conn, &Owner::host(&format!("retired-{n}"))?)?;
            }
            Ok(())
        })
    })
    .unwrap();
    platform.delete_fails.store(true, Ordering::SeqCst);
    for _ in 0..count {
        assert_eq!(
            call(|job| service.retire_one(job)).unwrap_err().to_string(),
            "vault.forget: controlled platform denial"
        );
    }
    assert!(!call(|job| service.retire_one(job)).unwrap());
}

#[test]
fn cleanup_only_recovery_reports_progress_until_every_prior_run_page_is_released() {
    let (db, platform, _, run) = fixture();
    let service = Service::new(&db, &*platform, run).unwrap();
    queue_failed_deletions(&db, &platform, &service, 33);
    let restart = Service::new(&db, &*platform, Uuid::new_v4()).unwrap();
    assert_eq!(restart.recover_startup_page().unwrap(), 32);
    assert_eq!(restart.recover_startup_page().unwrap(), 1);
    assert_eq!(restart.recover_startup_page().unwrap(), 0);
    platform.delete_fails.store(false, Ordering::SeqCst);
    let mut retired = 0;
    while call(|job| restart.retire_one(job)).unwrap() {
        retired += 1;
    }
    assert_eq!(retired, 33);
    assert_eq!(platform.writes.load(Ordering::SeqCst), 0);
    assert_eq!(platform.values.lock().unwrap().len(), 1);
    assert_eq!(
        platform.values.lock().unwrap().get("saved-host").unwrap(),
        "old-secret"
    );
}

#[test]
fn mixed_recovery_shares_one_page_budget_between_unknown_writes_and_old_cleanup_claims() {
    let (db, platform, _, run) = fixture();
    let service = Service::new(&db, &*platform, run).unwrap();
    queue_failed_deletions(&db, &platform, &service, 20);
    platform.write_reply_lost.store(true, Ordering::SeqCst);
    for n in 0..20 {
        let request = service
            .capture(
                Owner::host(&format!("unknown-{n}")).unwrap(),
                || Ok(()),
                scope,
            )
            .unwrap();
        assert!(call(|job| service.save(&request, "unknown-secret", job)).is_err());
    }
    let restart = Service::new(&db, &*platform, Uuid::new_v4()).unwrap();
    assert_eq!(restart.recover_startup_page().unwrap(), 32);
    let still_claimed: i64 = db
        .with(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM credential_cleanup WHERE claimed_run IS NOT NULL",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(still_claimed, 8);
    assert_eq!(restart.recover_startup_page().unwrap(), 8);
    assert_eq!(restart.recover_startup_page().unwrap(), 0);
    platform.delete_fails.store(false, Ordering::SeqCst);
    let mut retired = 0;
    while call(|job| restart.retire_one(job)).unwrap() {
        retired += 1;
    }
    assert_eq!(retired, 40);
    assert_eq!(item_count(&db), 0);
    assert_eq!(platform.writes.load(Ordering::SeqCst), 20);
    assert_eq!(platform.values.lock().unwrap().len(), 1);
}

#[test]
fn startup_recovery_cannot_release_a_claim_owned_by_its_current_run() {
    let (db, platform, _, run) = fixture();
    let service = Service::new(&db, &*platform, run).unwrap();
    queue_failed_deletions(&db, &platform, &service, 1);
    assert_eq!(service.recover_startup_page().unwrap(), 0);
    assert!(!call(|job| service.retire_one(job)).unwrap());
    assert_eq!(platform.deletes.load(Ordering::SeqCst), 1);
}
