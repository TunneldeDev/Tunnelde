use super::*;

#[test]
fn authority_changed_during_os_write_retires_only_the_staged_item_and_preserves_original_error() {
    for policy_change in [true, false] {
        let (db, platform, owner, run) = fixture();
        let allowed = Arc::new(AtomicBool::new(true));
        let revoked = allowed.clone();
        let changed = db.clone();
        *platform.hook.lock().unwrap() = Some(Arc::new(move |stage, _| {
            if stage == Stage::Write {
                if policy_change {
                    revoked.store(false, Ordering::SeqCst);
                } else {
                    changed.with(|conn| {
                        conn.execute(
                            "UPDATE settings SET value='changed' WHERE key='qa.scope'",
                            [],
                        )?;
                        Ok(())
                    })?;
                }
            }
            Ok(())
        }));
        let service = Service::new(&db, &*platform, run).unwrap();
        let request = service
            .capture(
                owner.clone(),
                || {
                    if !allowed.load(Ordering::SeqCst) {
                        return Err(AppError::validation("controlled original request revoked"));
                    }
                    Ok(())
                },
                scope,
            )
            .unwrap();
        let error = call(|job| service.save(&request, "unpublished-secret", job)).unwrap_err();
        assert_eq!(
            error.to_string(),
            if policy_change {
                "controlled original request revoked"
            } else {
                "credentials.changed"
            }
        );
        // Cleanup owns the staged item independently of the revoked request.
        assert!(call(|job| service.retire_one(job)).unwrap());
        assert!(!call(|job| service.retire_one(job)).unwrap());
        assert_eq!(platform.writes.load(Ordering::SeqCst), 1);
        assert_eq!(platform.deletes.load(Ordering::SeqCst), 1);
        assert_eq!(item_count(&db), 0);
        let current = service.capture(owner, || Ok(()), scope).unwrap();
        assert_eq!(
            call(|job| service.read(&current, job)).unwrap().as_deref(),
            Some("old-secret")
        );
    }
}

#[test]
fn a_competing_admitted_save_wins_without_the_old_write_deleting_its_replacement() {
    let (db, platform, owner, run) = fixture();
    let first = Arc::new(AtomicBool::new(true));
    // Keep a weak reference: the mock owns this callback and must not retain itself.
    let nested_platform = Arc::downgrade(&platform);
    let nested_db = db.clone();
    let nested_owner = owner.clone();
    *platform.hook.lock().unwrap() = Some(Arc::new(move |stage, _| {
        if stage == Stage::Write && first.swap(false, Ordering::SeqCst) {
            let platform = nested_platform.upgrade().unwrap();
            let service = Service::new(&nested_db, &*platform, run)?;
            let competing = service.capture(nested_owner.clone(), || Ok(()), scope)?;
            call(|job| service.save(&competing, "winning-secret", job))?;
        }
        Ok(())
    }));
    let service = Service::new(&db, &*platform, run).unwrap();
    let original = service.capture(owner.clone(), || Ok(()), scope).unwrap();
    assert_eq!(
        call(|job| service.save(&original, "losing-secret", job))
            .unwrap_err()
            .to_string(),
        "credentials.changed"
    );
    while call(|job| service.retire_one(job)).unwrap() {}
    let current = service.capture(owner, || Ok(()), scope).unwrap();
    assert_eq!(
        call(|job| service.read(&current, job)).unwrap().as_deref(),
        Some("winning-secret")
    );
    assert_eq!(platform.writes.load(Ordering::SeqCst), 2);
    assert_eq!(platform.deletes.load(Ordering::SeqCst), 2);
    assert_eq!(platform.values.lock().unwrap().len(), 1);
    assert_eq!(item_count(&db), 1);
}

#[test]
fn failed_written_confirmation_keeps_the_original_database_error_and_cleanup_identity() {
    let (db, platform, owner, run) = fixture();
    db.with(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER reject_written BEFORE UPDATE OF phase ON credential_operations
             WHEN NEW.phase='written'
             BEGIN SELECT RAISE(ABORT, 'controlled written confirmation failure'); END;",
        )?;
        Ok(())
    })
    .unwrap();
    let service = Service::new(&db, &*platform, run).unwrap();
    let request = service.capture(owner.clone(), || Ok(()), scope).unwrap();
    let error = call(|job| service.save(&request, "staged-secret", job)).unwrap_err();
    assert!(error
        .to_string()
        .contains("controlled written confirmation failure"));
    assert!(call(|job| service.retire_one(job)).unwrap());
    assert_eq!(item_count(&db), 0);
    let current = service.capture(owner, || Ok(()), scope).unwrap();
    assert_eq!(
        call(|job| service.read(&current, job)).unwrap().as_deref(),
        Some("old-secret")
    );
}

#[test]
fn restart_cleanup_of_an_unknown_write_cannot_remove_a_recreated_owners_secret() {
    let (db, platform, owner, run) = fixture();
    let service = Service::new(&db, &*platform, run).unwrap();
    let original = service.capture(owner.clone(), || Ok(()), scope).unwrap();
    platform.write_reply_lost.store(true, Ordering::SeqCst);
    assert!(call(|job| service.save(&original, "unknown-secret", job)).is_err());
    db.with(|conn| transaction(conn, |conn| bindings::invalidate(conn, &owner)))
        .unwrap();
    platform.write_reply_lost.store(false, Ordering::SeqCst);
    let recreated = service.capture(owner.clone(), || Ok(()), scope).unwrap();
    call(|job| service.save(&recreated, "replacement-secret", job)).unwrap();
    // No workers remain when the exclusive-startup recovery is simulated.
    let restart = Service::new(&db, &*platform, Uuid::new_v4()).unwrap();
    assert_eq!(restart.recover_startup_page().unwrap(), 1);
    while call(|job| restart.retire_one(job)).unwrap() {}
    let current = restart.capture(owner, || Ok(()), scope).unwrap();
    assert_eq!(
        call(|job| restart.read(&current, job)).unwrap().as_deref(),
        Some("replacement-secret")
    );
    assert_eq!(platform.writes.load(Ordering::SeqCst), 2);
    assert_eq!(platform.values.lock().unwrap().len(), 1);
    assert_eq!(item_count(&db), 1);
}

#[test]
fn unknown_write_quota_stops_os_writes_without_preventing_forget_or_losing_recovery_evidence() {
    let (db, platform, owner, run) = fixture();
    let service = Service::new(&db, &*platform, run).unwrap();
    let original = service.capture(owner.clone(), || Ok(()), scope).unwrap();
    platform.write_reply_lost.store(true, Ordering::SeqCst);
    for _ in 0..4 {
        let error = call(|job| service.save(&original, "unknown-secret", job)).unwrap_err();
        assert_eq!(error.to_string(), "vault.save: controlled reply loss");
    }
    assert_eq!(
        call(|job| service.save(&original, "must-not-be-written", job))
            .unwrap_err()
            .to_string(),
        "credentials.cleanupRequired"
    );
    assert_eq!(platform.writes.load(Ordering::SeqCst), 4);
    assert_eq!(item_count(&db), 4);
    call(|job| service.forget(&original, job)).unwrap();
    let restart = Service::new(&db, &*platform, Uuid::new_v4()).unwrap();
    assert_eq!(restart.recover_startup_page().unwrap(), 4);
    while call(|job| restart.retire_one(job)).unwrap() {}
    let current = restart.capture(owner, || Ok(()), scope).unwrap();
    assert!(call(|job| restart.read(&current, job)).unwrap().is_none());
    assert!(platform.values.lock().unwrap().is_empty());
    assert_eq!(item_count(&db), 0);
    assert_eq!(platform.writes.load(Ordering::SeqCst), 4);
}
