use super::*;

fn fixture() -> (crate::db::Database, Record) {
    (
        crate::db::Database::in_memory().unwrap(),
        Record {
            id: uuid::Uuid::new_v4().to_string(),
            host_id: "host".into(),
            address: "user@host:22".into(),
            path: "/note.txt".into(),
            directory: "/.tunnelde-save-test".into(),
            token: uuid::Uuid::new_v4().to_string(),
            receipt: Some(recovery::Receipt::new()),
            admission: None,
            removing_marker: false,
            updated_at: 0,
            error: None,
        },
    )
}

#[test]
fn unknown_intent_is_durable_and_never_forgotten_or_inferred_from_absence() {
    let (db, mut record) = fixture();
    db.with(|conn| create(conn, &record)).unwrap();
    recovery::begin(&mut record, recovery::Operation::Create, &|r| {
        db.with(|conn| persist(conn, r))
    })
    .unwrap();
    let restored = db.with(|conn| load(conn, &record.id)).unwrap().unwrap();
    assert_eq!(
        recovery::require_settled(&restored)
            .unwrap_err()
            .to_string(),
        "editor.remoteOutcomeUnknown"
    );
    assert_eq!(
        db.with(|conn| forget(conn, &restored))
            .unwrap_err()
            .to_string(),
        "editor.remoteOutcomeUnknown"
    );
    assert!(db.with(|conn| load(conn, &record.id)).unwrap().is_some());
    let synchronous = db
        .with(|conn| Ok(conn.pragma_query_value::<i64, _>(None, "synchronous", |row| row.get(0))?))
        .unwrap();
    assert_eq!(synchronous, 2); // in-memory DB's original FULL mode is restored.
}

#[test]
fn stale_forget_and_retired_writes_cannot_discard_or_resurrect_journals() {
    let (db, mut record) = fixture();
    db.with(|conn| create(conn, &record)).unwrap();
    let old = record.clone();
    recovery::begin(&mut record, recovery::Operation::Create, &|r| {
        db.with(|conn| persist(conn, r))
    })
    .unwrap();
    assert_eq!(
        db.with(|conn| forget(conn, &old)).unwrap_err().to_string(),
        "editor.cleanupBusy"
    );
    recovery::settle(&mut record, false, &|r| db.with(|conn| persist(conn, r))).unwrap();
    db.with(|conn| forget(conn, &record)).unwrap();
    assert_eq!(
        db.with(|conn| persist(conn, &record))
            .unwrap_err()
            .to_string(),
        "editor.cleanupMissing"
    );
    assert!(db.with(|conn| load(conn, &record.id)).unwrap().is_none());
}

#[test]
fn failed_terminal_checkpoint_keeps_unknown_in_memory_and_storage() {
    let (db, mut record) = fixture();
    db.with(|conn| create(conn, &record)).unwrap();
    recovery::begin(&mut record, recovery::Operation::Create, &|r| {
        db.with(|conn| persist(conn, r))
    })
    .unwrap();
    assert!(
        recovery::settle(&mut record, true, &|_| Err(AppError::internal("disk full"))).is_err()
    );
    assert!(recovery::require_settled(&record).is_err());
    assert!(
        recovery::require_settled(&db.with(|conn| load(conn, &record.id)).unwrap().unwrap())
            .is_err()
    );
}

#[test]
fn old_records_are_readable_but_missing_receipts_are_not_authority() {
    let (db, record) = fixture();
    let mut raw = serde_json::to_value(&record).unwrap();
    raw.as_object_mut().unwrap().remove("receipt");
    raw.as_object_mut().unwrap().remove("admission");
    db.with(|conn| {
        conn.execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,0)",
            rusqlite::params![format!("{PREFIX}{}", record.id), raw.to_string()],
        )?;
        Ok(())
    })
    .unwrap();
    let restored = db.with(|conn| load(conn, &record.id)).unwrap().unwrap();
    assert_eq!(
        recovery::require_settled(&restored)
            .unwrap_err()
            .to_string(),
        "editor.remoteOutcomeUnknown"
    );
    assert!(db.with(|conn| forget(conn, &restored)).is_err());
}

#[test]
fn creation_budget_preserves_all_unknown_records_and_rejects_more_before_io() {
    let (db, mut record) = fixture();
    for _ in 0..128 {
        record.id = uuid::Uuid::new_v4().to_string();
        db.with(|conn| create(conn, &record)).unwrap();
    }
    record.id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        db.with(|conn| create(conn, &record))
            .unwrap_err()
            .to_string(),
        "editor.remoteRecoveryLimit"
    );
    assert!(db.with(|conn| load(conn, &record.id)).unwrap().is_none());
}

#[test]
fn durable_intent_survives_database_close_and_reopen() {
    let root = std::env::temp_dir().join(format!(
        "tunnelde-editor-recovery-db-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("state.db");
    let (_, mut record) = fixture();
    {
        let db = crate::db::Database::open(&path).unwrap();
        db.with(|conn| create(conn, &record)).unwrap();
        recovery::begin(&mut record, recovery::Operation::Create, &|r| {
            db.with(|conn| persist(conn, r))
        })
        .unwrap();
    }
    {
        let db = crate::db::Database::open(&path).unwrap();
        let restored = db.with(|conn| load(conn, &record.id)).unwrap().unwrap();
        assert_eq!(
            recovery::require_settled(&restored)
                .unwrap_err()
                .to_string(),
            "editor.remoteOutcomeUnknown"
        );
        let synchronous = db
            .with(|conn| {
                Ok(conn.pragma_query_value::<i64, _>(None, "synchronous", |row| row.get(0))?)
            })
            .unwrap();
        assert_eq!(synchronous, 1); // restore the application's NORMAL setting.
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_observer_cannot_overwrite_a_more_recent_receipt() {
    let (db, mut record) = fixture();
    db.with(|conn| create(conn, &record)).unwrap();
    recovery::begin(&mut record, recovery::Operation::Create, &|r| {
        db.with(|conn| persist(conn, r))
    })
    .unwrap();
    let old = record.clone();
    recovery::settle(&mut record, true, &|r| db.with(|conn| persist(conn, r))).unwrap();
    assert_eq!(
        db.with(|conn| persist(conn, &old)).unwrap_err().to_string(),
        "editor.cleanupBusy"
    );
    assert!(
        recovery::require_settled(&db.with(|conn| load(conn, &record.id)).unwrap().unwrap())
            .unwrap()
    );
}

#[test]
fn durable_admission_link_is_assigned_once_and_stale_records_cannot_remove_it() {
    let (db, mut record) = fixture();
    db.with(|conn| create(conn, &record)).unwrap();
    let stale = record.clone();
    let reference = || {
        serde_json::from_value(serde_json::json!({
            "journalId": uuid::Uuid::new_v4().to_string(),
            "claimId": uuid::Uuid::new_v4().to_string()
        }))
        .unwrap()
    };
    record.admission = Some(reference());
    db.with(|conn| persist(conn, &record)).unwrap();
    db.with(|conn| persist(conn, &record)).unwrap();
    assert!(db.with(|conn| persist(conn, &stale)).is_err());
    assert!(db.with(|conn| forget(conn, &stale)).is_err());
    let mut changed = record.clone();
    changed.admission = Some(reference());
    assert!(db.with(|conn| persist(conn, &changed)).is_err());
    let restored = db.with(|conn| load(conn, &record.id)).unwrap().unwrap();
    assert!(restored.admission == record.admission);
    db.with(|conn| forget(conn, &restored)).unwrap();
}
